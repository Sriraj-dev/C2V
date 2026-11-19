import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customers, orders, payments, products, subscriptionItems, subscriptions, type Address, type SubscriptionRow } from '../../db/schema.js';
import { orderPhone } from '../orders/views.js';

export type SubscriptionStatus = SubscriptionRow['status'];
export type PaymentStatus = (typeof payments.$inferSelect)['status'];

export interface SubscriptionView {
  id: string;
  status: SubscriptionStatus;
  frequency: SubscriptionRow['frequency'];
  deliveryWeekday: number;
  nextDeliveryDate: string | null;
  perDeliveryTotalPaise: number;
  pincode: string;
  address: Address;
  customer: { id: string; profileName: string | null; phone: string | null };
  createdAt: string;
}

export interface SubscriptionDetail extends SubscriptionView {
  items: { productId: string; name: string; quantity: number; unitPricePaise: number; active: boolean }[];
  charges: { id: string; forDeliveryDate: string | null; amountPaise: number; status: PaymentStatus; orderId: string | null; orderCode: string | null; createdAt: string }[];
}

/** Views for rows already scoped to the tenant; one customer query regardless of row count. */
export async function toSubscriptionViews(db: Db, tenantId: string, rows: SubscriptionRow[]): Promise<SubscriptionView[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const cs = await db.select().from(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.id, ids)));
  const byId = new Map(cs.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = byId.get(r.customerId);
    return {
      id: r.id,
      status: r.status,
      frequency: r.frequency,
      deliveryWeekday: r.deliveryWeekday,
      nextDeliveryDate: r.nextDeliveryDate,
      perDeliveryTotalPaise: r.perDeliveryTotalPaise,
      pincode: r.pincode,
      address: r.address,
      customer: { id: r.customerId, profileName: c?.profileName ?? null, phone: orderPhone(c?.waId, r.address) },
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export async function listSubscriptions(
  db: Db,
  tenantId: string,
  f: { statuses?: SubscriptionStatus[]; customerId?: string; page: number; pageSize: number },
): Promise<{ items: SubscriptionView[]; total: number }> {
  const where = and(
    eq(subscriptions.tenantId, tenantId),
    f.statuses?.length ? inArray(subscriptions.status, f.statuses) : undefined,
    f.customerId ? eq(subscriptions.customerId, f.customerId) : undefined,
  );
  const [totalRow] = await db.select({ n: count() }).from(subscriptions).where(where);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(where)
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items: await toSubscriptionViews(db, tenantId, rows), total: totalRow?.n ?? 0 };
}

/** Items at current prices (with each product's active flag) and charges newest first with their order codes. */
export async function getSubscriptionDetail(db: Db, tenantId: string, id: string): Promise<SubscriptionDetail | null> {
  const [row] = await db.select().from(subscriptions).where(and(eq(subscriptions.tenantId, tenantId), eq(subscriptions.id, id))).limit(1);
  if (!row) return null;
  const [view] = await toSubscriptionViews(db, tenantId, [row]);
  const [items, charges] = await Promise.all([
    db
      .select({ productId: products.id, name: products.name, quantity: subscriptionItems.quantity, unitPricePaise: products.pricePaise, active: products.active })
      .from(subscriptionItems)
      .innerJoin(products, eq(products.id, subscriptionItems.productId))
      .where(eq(subscriptionItems.subscriptionId, id))
      .orderBy(asc(subscriptionItems.createdAt), asc(subscriptionItems.id)),
    db
      .select({ p: payments, orderCode: orders.orderCode })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.tenantId, tenantId), eq(payments.subscriptionId, id), eq(payments.kind, 'subscription_charge')))
      .orderBy(desc(payments.forDeliveryDate), desc(payments.createdAt)),
  ]);
  return {
    ...view!,
    items,
    charges: charges.map(({ p, orderCode }) => ({
      id: p.id,
      forDeliveryDate: p.forDeliveryDate,
      amountPaise: p.amountPaise,
      status: p.status,
      orderId: p.orderId,
      orderCode: orderCode ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}
