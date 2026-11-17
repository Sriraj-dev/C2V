import { and, asc, count, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customers, orders, payments } from '../../db/schema.js';
import { localPhoneDigits } from '../search.js';
import { toOrderViews, type OrderStatus, type OrderView } from './views.js';

export const ACTIVE_STATUSES: OrderStatus[] = ['confirmed', 'assigned', 'out_for_delivery'];

export interface OrderFilter {
  statuses?: OrderStatus[];
  deliveryFrom?: string;
  deliveryTo?: string;
  pincode?: string;
  partnerId?: string;
  q?: string;
  page: number;
  pageSize: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function listActiveOrders(db: Db, tenantId: string): Promise<OrderView[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), inArray(orders.status, ACTIVE_STATUSES)))
    .orderBy(desc(orders.createdAt), desc(orders.id));
  return toOrderViews(db, tenantId, rows);
}

export async function listOrders(
  db: Db,
  tenantId: string,
  f: OrderFilter,
): Promise<{ items: OrderView[]; total: number }> {
  const conds: (SQL | undefined)[] = [eq(orders.tenantId, tenantId)];
  if (f.statuses?.length) conds.push(inArray(orders.status, f.statuses));
  if (f.deliveryFrom) conds.push(gte(orders.deliveryDate, f.deliveryFrom));
  if (f.deliveryTo) conds.push(lte(orders.deliveryDate, f.deliveryTo));
  if (f.pincode) conds.push(eq(orders.pincode, f.pincode));
  if (f.partnerId) conds.push(eq(orders.assignedPartnerId, f.partnerId));
  const q = f.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    const alts: SQL[] = [sql`${orders.orderCode} ilike ${`%${escapeLike(q)}%`}`];
    if (digits) {
      alts.push(
        sql`${orders.customerId} in (select ${customers.id} from ${customers} where ${customers.tenantId} = ${tenantId} and ${customers.waId} like ${`%${digits}%`})`,
        sql`${orders.address}->>'phone' like ${`%${localPhoneDigits(digits)}%`}`,
      );
    }
    conds.push(or(...alts));
  }
  const where = and(...conds);
  const [totalRow] = await db.select({ n: count() }).from(orders).where(where);
  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items: await toOrderViews(db, tenantId, rows), total: totalRow?.n ?? 0 };
}

export async function getOrderView(db: Db, tenantId: string, id: string): Promise<OrderView | null> {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id)))
    .limit(1);
  if (!row) return null;
  return (await toOrderViews(db, tenantId, [row]))[0] ?? null;
}

export type RefundReason = 'cancelled_after_payment' | 'paid_after_expiry';

export async function listNeedsRefund(
  db: Db,
  tenantId: string,
): Promise<(OrderView & { refundReason: RefundReason })[]> {
  const rows = await db
    .selectDistinct({ order: orders })
    .from(orders)
    .innerJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.kind, 'link')))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(payments.tenantId, tenantId),
        eq(payments.status, 'paid'),
        inArray(orders.status, ['cancelled', 'expired']),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id));
  const views = await toOrderViews(
    db,
    tenantId,
    rows.map((r) => r.order),
  );
  return views.map((v) => ({
    ...v,
    refundReason: v.status === 'cancelled' ? 'cancelled_after_payment' : 'paid_after_expiry',
  }));
}
