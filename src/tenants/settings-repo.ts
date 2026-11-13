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
