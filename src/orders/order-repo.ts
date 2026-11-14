import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orderItems, orders, type OrderRow } from '../db/schema.js';

export type Order = OrderRow;
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderWithItems = Order & { items: OrderItem[] };

async function withItems(db: Db, order: Order | undefined): Promise<OrderWithItems | null> {
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.position, orderItems.id);
  return { ...order, items };
}

export async function findOrderById(db: Db, tenantId: string, id: string): Promise<OrderWithItems | null> {
  const [row] = await db.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, id))).limit(1);
  return withItems(db, row);
}

export async function findOrderByCode(db: Db, tenantId: string, code: string): Promise<OrderWithItems | null> {
  const [row] = await db.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.orderCode, code))).limit(1);
  return withItems(db, row);
}

export async function listRecentOrders(
  db: Db,
  tenantId: string,
  customerId: string,
  limit: number,
  excludeStatuses: Order['status'][] = [],
): Promise<OrderWithItems[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.customerId, customerId),
        excludeStatuses.length ? notInArray(orders.status, excludeStatuses) : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
  const out: OrderWithItems[] = [];
  for (const r of rows) out.push((await withItems(db, r))!);
  return out;
}
