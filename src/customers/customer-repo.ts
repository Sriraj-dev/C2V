import { eq, sql } from 'drizzle-orm';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import type { Db } from '../db/client.js';
import { customers, type Address, type CustomerRow } from '../db/schema.js';

export type { Address };
export type Customer = CustomerRow;

/** Atomic upsert keyed on (tenant, bsuid ?? waId); newly-known ids/name fill in, nulls never overwrite. */
export async function upsertCustomer(
  db: Db,
  tenantId: string,
  from: InboundMessage['from'],
): Promise<Customer> {
  const waKey = from.bsuid ?? from.waId;
  if (!waKey) throw new Error('upsertCustomer: message has neither bsuid nor waId');
  const [row] = await db
    .insert(customers)
    .values({
      tenantId,
      waKey,
      waId: from.waId,
      bsuid: from.bsuid,
      profileName: from.profileName,
    })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.waKey],
      set: {
        waId: sql`COALESCE(excluded.wa_id, ${customers.waId})`,
        bsuid: sql`COALESCE(excluded.bsuid, ${customers.bsuid})`,
        profileName: sql`COALESCE(excluded.profile_name, ${customers.profileName})`,
      },
    })
    .returning();
  return row!;
}

export function recipientOf(c: Customer): string {
  return c.waId ?? c.bsuid!;
}

export async function saveDefaultAddress(db: Db, customerId: string, address: Address): Promise<void> {
  await db.update(customers).set({ defaultAddress: address }).where(eq(customers.id, customerId));
}

export async function saveEmail(db: Db, customerId: string, email: string): Promise<void> {
  await db.update(customers).set({ email }).where(eq(customers.id, customerId));
}
