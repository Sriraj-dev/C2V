import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';

export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  return db as unknown as Db;
}

export async function seedTenantRow(
  db: Db,
  id = 'test',
  overrides: Partial<typeof schema.tenants.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.tenants)
    .values({ id, supportPhone: '910000000000', ...overrides })
    .returning();
  return row!;
}

let counter = 0;
const next = () => ++counter;

export async function seedProduct(
  db: Db,
  tenantId: string,
  overrides: Partial<typeof schema.products.$inferInsert> = {},
) {
  const n = next();
  const [row] = await db
    .insert(schema.products)
    .values({ tenantId, sku: `SKU_${n}`, name: `Product ${n}`, pricePaise: 9000, sortOrder: n, ...overrides })
    .returning();
  return row!;
}

export async function seedPincode(db: Db, tenantId: string, pincode: string, weekday: number) {
  const [row] = await db
    .insert(schema.pincodes)
    .values({ tenantId, pincode, deliveryWeekday: weekday })
    .returning();
  return row!;
}

export async function seedCustomer(
  db: Db,
  tenantId: string,
  overrides: Partial<typeof schema.customers.$inferInsert> = {},
) {
  const n = next();
  const [row] = await db
    .insert(schema.customers)
    .values({ tenantId, waKey: `91900000${String(n).padStart(4, '0')}`, waId: null, ...overrides })
    .returning();
  return row!;
}
