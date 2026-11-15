import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';

export type TenantSettings = {
  supportPhone: string | null;
  welcomeImageUrl: string | null;
  deliveryFeePaise: number; minOrderPaise: number;
};

export async function getTenantSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!row) throw new Error(`Tenant settings not found: ${tenantId}`);
  return {
    supportPhone: row.supportPhone,
    welcomeImageUrl: row.welcomeImageUrl,
    deliveryFeePaise: row.deliveryFeePaise,
    minOrderPaise: row.minOrderPaise,
  };
}

export async function updateTenantSettings(
  db: Db,
  tenantId: string,
  patch: Partial<TenantSettings>,
): Promise<TenantSettings> {
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (patch.supportPhone !== undefined) set.supportPhone = patch.supportPhone;
  if (patch.welcomeImageUrl !== undefined) set.welcomeImageUrl = patch.welcomeImageUrl;
  if (patch.deliveryFeePaise !== undefined) set.deliveryFeePaise = patch.deliveryFeePaise;
  if (patch.minOrderPaise !== undefined) set.minOrderPaise = patch.minOrderPaise;
  if (Object.keys(set).length > 0) {
    const rows = await db.update(tenants).set({ ...set, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).returning({ id: tenants.id });
    if (rows.length === 0) throw new Error(`Tenant settings not found: ${tenantId}`);
  }
  return getTenantSettings(db, tenantId);
}
