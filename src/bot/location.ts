import { and, eq, inArray } from 'drizzle-orm';
import { textMsg } from '../channels/whatsapp/builders.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import type { Customer } from '../customers/customer-repo.js';
import { customers, orders, subscriptions } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { sendMenu } from './menu.js';

/**
 * Saves a shared pin as the customer's default location and on their open orders/subscriptions.
 * No serviceability check: the pincode decides that. Out-of-range coordinates are ignored (menu instead).
 */
export async function onLocationShared(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  msg: Pick<Extract<InboundMessage, { kind: 'location' }>, 'lat' | 'lng'>,
): Promise<void> {
  const { lat, lng } = msg;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    deps.log.warn({ tenantId: tenant.id }, 'ignoring location with invalid coordinates');
    return sendMenu(deps, tenant, customer);
  }
  const location = { lat, lng };
  await deps.db.transaction(async (tx) => {
    await tx.update(customers).set({ defaultLocation: location }).where(and(eq(customers.tenantId, tenant.id), eq(customers.id, customer.id)));
    await tx
      .update(orders)
      .set({ location })
      .where(
        and(
          eq(orders.tenantId, tenant.id),
          eq(orders.customerId, customer.id),
          inArray(orders.status, ['confirmed', 'assigned', 'out_for_delivery']),
        ),
      );
    await tx
      .update(subscriptions)
      .set({ location })
      .where(
        and(
          eq(subscriptions.tenantId, tenant.id),
          eq(subscriptions.customerId, customer.id),
          inArray(subscriptions.status, ['active', 'pending_authorization']),
        ),
      );
  });
  const text = tenant.copy.locationSaved();
  await sendAndLog(deps, tenant, customer, textMsg(text), text);
}
