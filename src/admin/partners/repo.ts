import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { deliveryPartners, orders, type DeliveryPartnerRow } from '../../db/schema.js';
import { newToken } from '../auth/tokens.js';

export interface PartnerView {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  accessToken: string | null;
  accessTokenCreatedAt: string | null;
  openOrderCount: number;
  createdAt: string;
}

function toView(p: DeliveryPartnerRow, openOrderCount: number): PartnerView {
  return {
    id: p.id,
    name: p.name,
    phone: p.phone,
    active: p.active,
    accessToken: p.accessToken,
    accessTokenCreatedAt: p.accessTokenCreatedAt?.toISOString() ?? null,
    openOrderCount,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Open = assigned or out_for_delivery, one grouped query for all partners. */
async function openCounts(db: Db, tenantId: string, partnerIds: string[]): Promise<Map<string, number>> {
  if (partnerIds.length === 0) return new Map();
  const rows = await db
    .select({ partnerId: orders.assignedPartnerId, n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        inArray(orders.assignedPartnerId, partnerIds),
        inArray(orders.status, ['assigned', 'out_for_delivery']),
      ),
    )
    .groupBy(orders.assignedPartnerId);
  return new Map(rows.map((r) => [r.partnerId as string, r.n]));
}

async function viewOf(db: Db, row: DeliveryPartnerRow): Promise<PartnerView> {
  const counts = await openCounts(db, row.tenantId, [row.id]);
  return toView(row, counts.get(row.id) ?? 0);
}

export async function listPartners(db: Db, tenantId: string): Promise<PartnerView[]> {
  const rows = await db
    .select()
    .from(deliveryPartners)
    .where(eq(deliveryPartners.tenantId, tenantId))
    .orderBy(asc(deliveryPartners.createdAt), asc(deliveryPartners.id));
  const counts = await openCounts(
    db,
    tenantId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(r, counts.get(r.id) ?? 0));
}

export async function createPartner(
  db: Db,
  tenantId: string,
  input: { name: string; phone: string },
  now: Date,
): Promise<PartnerView> {
  const [row] = await db
    .insert(deliveryPartners)
    .values({ tenantId, name: input.name, phone: input.phone, accessToken: newToken(), accessTokenCreatedAt: now })
    .returning();
  return viewOf(db, row!);
}

export async function updatePartner(
  db: Db,
  tenantId: string,
  id: string,
  patch: { name?: string; phone?: string; active?: boolean },
): Promise<PartnerView | null> {
  const [row] = await db
    .update(deliveryPartners)
    .set(patch)
    .where(and(eq(deliveryPartners.tenantId, tenantId), eq(deliveryPartners.id, id)))
    .returning();
  return row ? viewOf(db, row) : null;
}

/** New token and timestamp in one UPDATE; the old link stops working immediately. */
export async function resetPartnerLink(db: Db, tenantId: string, id: string, now: Date): Promise<PartnerView | null> {
  const [row] = await db
    .update(deliveryPartners)
    .set({ accessToken: newToken(), accessTokenCreatedAt: now })
    .where(and(eq(deliveryPartners.tenantId, tenantId), eq(deliveryPartners.id, id)))
    .returning();
  return row ? viewOf(db, row) : null;
}

/** The active partner with exactly this token, or null. */
export async function findPartnerByToken(db: Db, token: string): Promise<DeliveryPartnerRow | null> {
  const [row] = await db
    .select()
    .from(deliveryPartners)
    .where(and(eq(deliveryPartners.accessToken, token), eq(deliveryPartners.active, true)))
    .limit(1);
  return row ?? null;
}
