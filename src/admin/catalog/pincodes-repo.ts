import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { pincodes, type PincodeRow } from '../../db/schema.js';

export interface PincodeView {
  id: string;
  pincode: string;
  deliveryWeekday: number;
  note: string | null;
  active: boolean;
  createdAt: string;
}

export interface PincodeInput {
  pincode: string;
  deliveryWeekday: number;
  note?: string | null;
  active?: boolean;
}

export interface PincodePatch {
  deliveryWeekday?: number;
  note?: string | null;
  active?: boolean;
}

function toView(r: PincodeRow): PincodeView {
  return {
    id: r.id,
    pincode: r.pincode,
    deliveryWeekday: r.deliveryWeekday,
    note: r.note,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listPincodes(db: Db, tenantId: string): Promise<PincodeView[]> {
  const rows = await db.select().from(pincodes).where(eq(pincodes.tenantId, tenantId)).orderBy(asc(pincodes.pincode));
  return rows.map(toView);
}

/** A duplicate (tenant, pincode) throws a unique violation, mapped to 409 `conflict` by the error handler. */
export async function createPincode(db: Db, tenantId: string, input: PincodeInput): Promise<PincodeView> {
  const [row] = await db
    .insert(pincodes)
    .values({
      tenantId,
      pincode: input.pincode,
      deliveryWeekday: input.deliveryWeekday,
      note: input.note ?? null,
      active: input.active ?? true,
    })
    .returning();
  return toView(row!);
}

/** Null when the pincode doesn't exist for this tenant. */
export async function updatePincode(
  db: Db,
  tenantId: string,
  id: string,
  patch: PincodePatch,
): Promise<PincodeView | null> {
  const [row] = await db
    .update(pincodes)
    .set(patch)
    .where(and(eq(pincodes.tenantId, tenantId), eq(pincodes.id, id)))
    .returning();
  return row ? toView(row) : null;
}
