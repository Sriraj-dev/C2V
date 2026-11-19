import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customers, orders, type Address, type GeoLocation } from '../../db/schema.js';
import { localPhoneDigits } from '../search.js';
import { toOrderViews, type OrderView } from '../orders/views.js';
import { listSubscriptions, type SubscriptionView } from '../subscriptions/queries.js';

type CustomerRow = typeof customers.$inferSelect;

export interface CustomerView {
  id: string;
  profileName: string | null;
  phone: string | null;
  email: string | null;
  defaultAddress: Address | null;
  defaultLocation: GeoLocation | null;
  createdAt: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function toCustomerView(c: CustomerRow): CustomerView {
  const addrPhone = c.defaultAddress?.phone;
  return {
    id: c.id,
    profileName: c.profileName,
    phone: c.waId ?? (addrPhone ? `91${addrPhone}` : null),
    email: c.email,
    defaultAddress: c.defaultAddress ?? null,
    defaultLocation: c.defaultLocation ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCustomers(
  db: Db,
  tenantId: string,
  f: { q?: string; page: number; pageSize: number },
): Promise<{ items: CustomerView[]; total: number }> {
  const conds: (SQL | undefined)[] = [eq(customers.tenantId, tenantId)];
  const q = f.q?.trim();
  if (q) {
    const text = `%${escapeLike(q)}%`;
    const alts: SQL[] = [
      sql`${customers.profileName} ilike ${text}`,
      sql`${customers.defaultAddress}->>'name' ilike ${text}`,
    ];
    const digits = q.replace(/\D/g, '');
    if (digits) {
      const local = localPhoneDigits(digits);
      alts.push(
        sql`${customers.waId} like ${`%${digits}%`}`,
        sql`${customers.defaultAddress}->>'phone' like ${`%${local}%`}`,
      );
    }
    conds.push(or(...alts));
  }
  const where = and(...conds);
  const [totalRow] = await db.select({ n: count() }).from(customers).where(where);
  const rows = await db
    .select()
    .from(customers)
    .where(where)
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items: rows.map(toCustomerView), total: totalRow?.n ?? 0 };
}

export async function getCustomer(
  db: Db,
  tenantId: string,
  id: string,
): Promise<{ customer: CustomerView; orders: OrderView[]; subscriptions: SubscriptionView[] } | null> {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
    .limit(1);
  if (!row) return null;
  const recent = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, id)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(20);
  const subs = await listSubscriptions(db, tenantId, { customerId: id, page: 1, pageSize: 20 });
  return { customer: toCustomerView(row), orders: await toOrderViews(db, tenantId, recent), subscriptions: subs.items };
}
