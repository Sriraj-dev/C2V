import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { vendorSessions, vendorUsers, type VendorSessionRow, type VendorUserRow } from '../../db/schema.js';
import { newToken, sha256Hex } from './tokens.js';

export const SESSION_DAYS = 30;

/** Stores only the token's sha256; the plaintext token is returned once. */
export async function createSession(
  db: Db,
  input: { vendorUserId: string; tenantId: string; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_DAYS * 86_400_000);
  await db.insert(vendorSessions).values({
    vendorUserId: input.vendorUserId,
    tenantId: input.tenantId,
    tokenHash: sha256Hex(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function findSessionByToken(
  db: Db,
  tokenHash: string,
): Promise<{ session: VendorSessionRow; vendor: VendorUserRow } | null> {
  const [row] = await db
    .select({ session: vendorSessions, vendor: vendorUsers })
    .from(vendorSessions)
    .innerJoin(vendorUsers, eq(vendorUsers.id, vendorSessions.vendorUserId))
    .where(eq(vendorSessions.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(vendorSessions).where(eq(vendorSessions.id, id));
}

export async function deleteVendorSessions(db: Db, vendorUserId: string): Promise<void> {
  await db.delete(vendorSessions).where(eq(vendorSessions.vendorUserId, vendorUserId));
}
