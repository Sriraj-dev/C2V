import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { vendorUsers, type VendorUserRow } from '../../db/schema.js';

/** Usernames are case-insensitive: always stored and looked up trimmed + lowercased. */
const norm = (u: string) => u.trim().toLowerCase();

export async function createVendor(
  db: Db,
  input: { tenantId: string; username: string; passwordHash: string },
): Promise<VendorUserRow> {
  const [row] = await db
    .insert(vendorUsers)
    .values({ tenantId: input.tenantId, username: norm(input.username), passwordHash: input.passwordHash })
    .returning();
  return row!;
}

export async function findVendorByUsername(db: Db, username: string): Promise<VendorUserRow | null> {
  const [row] = await db.select().from(vendorUsers).where(eq(vendorUsers.username, norm(username))).limit(1);
  return row ?? null;
}

export async function setVendorPassword(db: Db, id: string, passwordHash: string, now: Date): Promise<void> {
  await db.update(vendorUsers).set({ passwordHash, passwordChangedAt: now }).where(eq(vendorUsers.id, id));
}

export async function setVendorActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.update(vendorUsers).set({ active }).where(eq(vendorUsers.id, id));
}
