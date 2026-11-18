import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Address, Customer } from '../customers/customer-repo.js';
import { subscriptionItems, subscriptions, type GeoLocation, type SubscriptionRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import type { Frequency } from '../domain/delivery-date.js';
import type { OrderLine } from '../orders/order-service.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';

/** Mandate max = this × per-delivery total, so moderate price rises still fit (spec §10). */
export const MANDATE_HEADROOM = 2;
/** Mandates are open-ended in practice; Cashfree needs an expiry. */
const MANDATE_YEARS = 10;

export interface NewSubscriptionInput {
  lines: OrderLine[];
  address: Address;
  location: GeoLocation | null;
  frequency: Frequency;
  deliveryWeekday: number;
  email: string;
  /** 10-digit or 91-prefixed Indian mobile for the mandate (the WhatsApp number, or the one asked for). */
  phone: string;
}

export interface CreatedSubscription {
  subscription: SubscriptionRow;
  perDeliveryPaise: number;
  /** Our authorisation page, `<PUBLIC_BASE_URL>/subscribe/<authToken>`. */
  authUrl: string;
}

export const subscribePageUrl = (deps: AppDeps, token: string) => `${deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/subscribe/${token}`;

/**
 * Saves a `pending_authorization` subscription with its items (current prices + delivery fee per delivery), then
 * creates the Cashfree mandate (max = 2 × per delivery). If Cashfree fails, the rows are deleted and the error rethrown.
 */
export async function createSubscription(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  i: NewSubscriptionInput,
): Promise<CreatedSubscription> {
  const { deliveryFeePaise } = await getTenantSettings(deps.db, tenant.id);
  const perDeliveryPaise = i.lines.reduce((s, l) => s + l.product.pricePaise * l.quantity, 0) + deliveryFeePaise;
  const authToken = randomBytes(32).toString('base64url');

  const sub = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(subscriptions)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        status: 'pending_authorization',
        frequency: i.frequency,
        address: i.address,
        location: i.location,
        pincode: i.address.pincode,
        deliveryWeekday: i.deliveryWeekday,
        perDeliveryTotalPaise: perDeliveryPaise,
        authToken,
      })
      .returning();
    await tx.insert(subscriptionItems).values(i.lines.map((l) => ({ subscriptionId: row!.id, productId: l.product.id, quantity: l.quantity })));
    return row!;
  });

  let created: { cfSubscriptionId: string; sessionId: string };
  try {
    const expiresAt = new Date(deps.now());
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + MANDATE_YEARS);
    created = await deps.payments.createSubscription(tenant, {
      subscriptionId: sub.id,
      maxAmountPaise: MANDATE_HEADROOM * perDeliveryPaise,
      expiresAt,
      customer: { name: i.address.name, email: i.email, phone: i.phone },
      returnUrl: `${subscribePageUrl(deps, authToken)}/done`,
    });
  } catch (err) {
    await deps.db.transaction(async (tx) => {
      await tx.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id));
      await tx.delete(subscriptions).where(eq(subscriptions.id, sub.id));
    });
    throw err;
  }
  const [updated] = await deps.db
    .update(subscriptions)
    .set({ cfSubscriptionId: created.cfSubscriptionId, cfSessionId: created.sessionId, updatedAt: deps.now() })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return { subscription: updated!, perDeliveryPaise, authUrl: subscribePageUrl(deps, authToken) };
}
