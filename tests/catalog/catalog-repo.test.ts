import { beforeEach, describe, expect, it } from 'vitest';
import { findActivePincode, listActiveProducts } from '../../src/catalog/catalog-repo.js';
import type { Db } from '../../src/db/client.js';
import { pincodes, products } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createTestDb, seedPincode, seedProduct, seedTenantRow } from '../helpers/test-db.js';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  await seedTenantRow(db, 'other');
});

describe('listActiveProducts', () => {
  it('orders by sort_order, excludes inactive and other tenants', async () => {
    const b = await seedProduct(db, 'test', { name: 'B', sortOrder: 2 });
    const a = await seedProduct(db, 'test', { name: 'A', sortOrder: 1 });
    const off = await seedProduct(db, 'test', { name: 'Off', sortOrder: 0 });
    await db.update(products).set({ active: false }).where(eq(products.id, off.id));
    await seedProduct(db, 'other', { name: 'X', sortOrder: 0 });
    expect((await listActiveProducts(db, 'test')).map((p) => p.id)).toEqual([a.id, b.id]);
  });
});

describe('findActivePincode', () => {
  it('finds active, rejects inactive and unknown', async () => {
    await seedPincode(db, 'test', '560034', 3);
    const off = await seedPincode(db, 'test', '560102', 3);
    await db.update(pincodes).set({ active: false }).where(eq(pincodes.id, off.id));
    expect((await findActivePincode(db, 'test', '560034'))?.deliveryWeekday).toBe(3);
    expect(await findActivePincode(db, 'test', '560102')).toBeNull();
    expect(await findActivePincode(db, 'test', '999999')).toBeNull();
    expect(await findActivePincode(db, 'other', '560034')).toBeNull();
  });
});
