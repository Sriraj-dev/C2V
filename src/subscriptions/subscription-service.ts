import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { errInfo } from '../bot/log.js';
import { textMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import type { Address, Customer } from '../customers/customer-repo.js';
import { customers, orders, payments, subscriptionItems, subscriptions, type GeoLocation, type SubscriptionRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { firstSubscriptionDelivery, formatDeliveryDate, frequencyLabel, type Frequency } from '../domain/delivery-date.js';
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

export type SubscriptionStatusResult = 'activated' | 'auth_failed' | 'cancelled' | 'unchanged';

/** Cashfree states that end a mandate for good (spec §10 "Mandate changes"). */
const ENDED = new Set(['CANCELLED', 'CUSTOMER_CANCELLED', 'EXPIRED', 'CARD_EXPIRED', 'COMPLETED', 'LINK_EXPIRED']);

/**
 * Applies a Cashfree subscription change. Never trusts the webhook body: re-fetches the subscription and moves the
 * local row with a conditional UPDATE, so repeated webhooks act once. CUSTOMER_PAUSED / BANK_APPROVAL_PENDING and
 * other in-between states change nothing (the charge job checks for a pause before raising).
 */
export async function onSubscriptionStatus(
  deps: AppDeps,
  tenant: TenantConfig,
  subscriptionId: string,
): Promise<SubscriptionStatusResult> {
  const [sub] = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.tenantId, tenant.id)))
    .limit(1);
  if (!sub) return 'unchanged';
  const remote = await deps.payments.getSubscription(tenant, subscriptionId);
  const authFailed = remote.authorizationStatus === 'FAILED';

  if (remote.status === 'ACTIVE') {
    // Also from authorization_failed: a retry on the same link can still succeed after a failed attempt.
    const nextDelivery = firstSubscriptionDelivery(deps.now(), sub.deliveryWeekday);
    const [row] = await deps.db
      .update(subscriptions)
      .set({ status: 'active', nextDeliveryDate: nextDelivery, updatedAt: deps.now() })
      .where(and(eq(subscriptions.id, sub.id), inArray(subscriptions.status, ['pending_authorization', 'authorization_failed'])))
      .returning();
    if (!row) return 'unchanged';
    deps.log.info({ tenantId: tenant.id, subscriptionId, nextDelivery }, 'subscription activated');
    await notify(deps, tenant, sub.customerId, tenant.copy.subscriptionActive({
      firstDelivery: formatDeliveryDate(nextDelivery),
      frequency: frequencyLabel(sub.frequency, sub.deliveryWeekday),
    }));
    return 'activated';
  }

  if (sub.status === 'pending_authorization' && (authFailed || ENDED.has(remote.status))) {
    const [row] = await deps.db
      .update(subscriptions)
      .set({ status: 'authorization_failed', updatedAt: deps.now() })
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, 'pending_authorization')))
      .returning();
    if (!row) return 'unchanged';
    deps.log.info({ tenantId: tenant.id, subscriptionId, remoteStatus: remote.status }, 'subscription authorisation failed');
    await notify(deps, tenant, sub.customerId, tenant.copy.subscriptionAuthFailed());
    return 'auth_failed';
  }

  if (sub.status === 'active' && ENDED.has(remote.status)) {
    const [row] = await deps.db
      .update(subscriptions)
      .set({ status: 'cancelled', nextDeliveryDate: null, updatedAt: deps.now() })
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, 'active')))
      .returning();
    if (!row) return 'unchanged';
    deps.log.info({ tenantId: tenant.id, subscriptionId, remoteStatus: remote.status }, 'subscription cancelled remotely');
    await cancelOpenCharges(deps, tenant, sub.id);
    await notify(deps, tenant, sub.customerId, tenant.copy.subscriptionCancelled());
    return 'cancelled';
  }
  return 'unchanged';
}

/**
 * Cancels every not-yet-collected (`created`) charge of a subscription at Cashfree; each one Cashfree accepts is marked
 * `cancelled` with its upcoming order. A charge Cashfree refuses (already collected or in progress) is left for the
 * charge result to settle.
 */
export async function cancelOpenCharges(deps: AppDeps, tenant: TenantConfig, subscriptionId: string): Promise<void> {
  const open = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.subscriptionId, subscriptionId), eq(payments.kind, 'subscription_charge'), eq(payments.status, 'created')));
  for (const p of open) {
    try {
      await deps.payments.cancelCharge(tenant, subscriptionId, p.providerRef);
    } catch (err) {
      deps.log.warn({ tenantId: tenant.id, subscriptionId, paymentId: p.id, err: errInfo(err) }, 'charge cancel refused; left for its result');
      continue;
    }
    await deps.db.transaction(async (tx) => {
      await tx.update(payments).set({ status: 'cancelled', updatedAt: deps.now() }).where(and(eq(payments.id, p.id), eq(payments.status, 'created')));
      if (p.orderId) {
        await tx
          .update(orders)
          .set({ status: 'cancelled', updatedAt: deps.now() })
          .where(and(eq(orders.id, p.orderId), eq(orders.status, 'payment_pending')));
      }
    });
  }
}

/** Sends a text to the subscription's customer; a failed send is logged and never undoes the state change. */
async function notify(deps: AppDeps, tenant: TenantConfig, customerId: string, text: string): Promise<void> {
  try {
    const [customer] = await deps.db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    if (!customer) return;
    await sendAndLog(deps, tenant, customer, textMsg(text), text);
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, err: errInfo(err) }, 'subscription message send failed');
  }
}
