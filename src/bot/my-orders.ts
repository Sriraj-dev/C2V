import { and, eq, inArray } from 'drizzle-orm';
import { textMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import type { Customer } from '../customers/customer-repo.js';
import { products, subscriptionItems, subscriptions } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { formatDeliveryDate, frequencyLabel } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { listRecentOrders } from '../orders/order-repo.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';
import { sendMenu } from './menu.js';

const LABELS: Record<string, string> = {
  payment_pending: 'Payment pending',
  confirmed: 'Confirmed',
  assigned: 'Assigned to delivery partner',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export function orderStatusLabel(status: string): string {
  const known = LABELS[status];
  if (known) return known;
  const s = status.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Last 5 orders (pending-payment included, so a customer who thinks they paid still sees the order;
 * expired/failed hidden) plus active subscriptions. Empty -> prompt, then the menu.
 */
export async function sendMyOrders(deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> {
  const { db } = deps;
  const orders = await listRecentOrders(db, tenant.id, customer.id, 5, ['expired', 'payment_failed']);
  const subs = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.tenantId, tenant.id), eq(subscriptions.customerId, customer.id), eq(subscriptions.status, 'active')),
    )
    .orderBy(subscriptions.createdAt, subscriptions.id)
    .limit(5);

  const subRows: { perDelivery: string; frequency: string; nextDelivery: string }[] = [];
  if (subs.length) {
    const { deliveryFeePaise } = await getTenantSettings(db, tenant.id);
    // Subscription items store no unit price, so the current product price is used (inactive products
    // are priced on purpose: current-price ruling).
    const items = await db
      .select({ subscriptionId: subscriptionItems.subscriptionId, quantity: subscriptionItems.quantity, pricePaise: products.pricePaise })
      .from(subscriptionItems)
      .innerJoin(products, eq(products.id, subscriptionItems.productId))
      .where(inArray(subscriptionItems.subscriptionId, subs.map((s) => s.id)));
    for (const s of subs) {
      const sum = items.filter((i) => i.subscriptionId === s.id).reduce((a, i) => a + i.quantity * i.pricePaise, 0);
      subRows.push({
        perDelivery: formatPaise(sum + deliveryFeePaise),
        frequency: frequencyLabel(s.frequency, s.deliveryWeekday),
        nextDelivery: s.nextDeliveryDate ? formatDeliveryDate(s.nextDeliveryDate) : 'pending',
      });
    }
  }

  const rows = orders.map((o) => ({
    orderCode: o.orderCode,
    status: orderStatusLabel(o.status),
    deliveryDate: formatDeliveryDate(o.deliveryDate),
    total: formatPaise(o.totalPaise),
  }));
  let body = tenant.copy.myOrders(rows, subRows);
  if (orders.some((o) => o.status === 'payment_pending')) body += `\n\n${tenant.copy.pendingPaymentNote()}`;
  await sendAndLog(deps, tenant, customer, textMsg(body), body);
  if (rows.length === 0 && subRows.length === 0) await sendMenu(deps, tenant, customer);
}
