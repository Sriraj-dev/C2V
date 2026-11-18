import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { subscriptions, type SubscriptionRow } from '../db/schema.js';

/** Shape of the random token in `/subscribe/:token` (32 random bytes, base64url). */
export const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function findSubscriptionByAuthToken(db: Db, token: string): Promise<SubscriptionRow | null> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.authToken, token)).limit(1);
  return row ?? null;
}
