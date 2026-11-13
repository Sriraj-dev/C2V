import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pincodes, products, type PincodeRow, type ProductRow } from '../db/schema.js';

export type Product = ProductRow;
export type Pincode = PincodeRow;

export async function listActiveProducts(db: Db, tenantId: string): Promise<Product[]> {
  return db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.active, true)))
    .orderBy(asc(products.sortOrder), asc(products.createdAt), asc(products.id));
}

export async function findActivePincode(db: Db, tenantId: string, pincode: string): Promise<Pincode | null> {
  const [row] = await db
    .select()
    .from(pincodes)
    .where(and(eq(pincodes.tenantId, tenantId), eq(pincodes.pincode, pincode), eq(pincodes.active, true)))
    .limit(1);
  return row ?? null;
}
