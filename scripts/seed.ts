import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as s from '../src/db/schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

// Inserts starting data only; never overwrites rows the vendor may have edited.
const TENANT = 'nutrifarm';
const client = postgres(url, { prepare: false, max: 1 });
const db = drizzle(client, { schema: s });

await db
  .insert(s.tenants)
  .values({ id: TENANT, supportPhone: '918310901383' })
  .onConflictDoNothing();

const products = [
  { sku: 'EGG_W_6', name: 'White Eggs – 6 pack', pricePaise: 9000, sortOrder: 1 },
  { sku: 'EGG_W_12', name: 'White Eggs – 12 pack', pricePaise: 16800, sortOrder: 2 },
  { sku: 'EGG_W_30', name: 'White Eggs – 30 pack', pricePaise: 39000, sortOrder: 3 },
];
for (const p of products) {
  await db
    .insert(s.products)
    .values({ tenantId: TENANT, ...p })
    .onConflictDoNothing();
}

const pins: [string, number][] = [
  ['560034', 3],
  ['560102', 3],
  ['560076', 3],
  ['560068', 6],
  ['560037', 6],
];
for (const [pincode, deliveryWeekday] of pins) {
  await db
    .insert(s.pincodes)
    .values({ tenantId: TENANT, pincode, deliveryWeekday })
    .onConflictDoNothing();
}

// delivery_partners has no natural unique key: insert only if absent.
const phone = '919398651343';
const existing = await db
  .select({ id: s.deliveryPartners.id })
  .from(s.deliveryPartners)
  .where(and(eq(s.deliveryPartners.tenantId, TENANT), eq(s.deliveryPartners.phone, phone)));
if (existing.length === 0) {
  await db.insert(s.deliveryPartners).values({ tenantId: TENANT, name: 'Ravi', phone });
}

await client.end();
console.log('seed complete');
