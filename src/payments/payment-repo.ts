import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { payments, type PaymentRow } from '../db/schema.js';

export type Payment = PaymentRow;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentStatus = Payment['status'];

export async function insertPayment(db: Db, row: NewPayment): Promise<Payment> {
  const [created] = await db.insert(payments).values(row).returning();
  return created!;
}

/** provider_ref is globally unique, so tenantId is only an optional extra guard. */
export async function findPaymentByProviderRef(db: Db, tenantId: string | undefined, ref: string): Promise<Payment | null> {
  const where = tenantId
    ? and(eq(payments.tenantId, tenantId), eq(payments.providerRef, ref))
    : eq(payments.providerRef, ref);
  const [row] = await db.select().from(payments).where(where).limit(1);
  return row ?? null;
}

export async function markPayment(db: Db, id: string, status: PaymentStatus, raw: unknown): Promise<Payment | null> {
  const [row] = await db.update(payments).set({ status, raw }).where(eq(payments.id, id)).returning();
  return row ?? null;
}
