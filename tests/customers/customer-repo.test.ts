import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { customers } from '../../src/db/schema.js';
import {
  recipientOf,
  saveDefaultAddress,
  saveEmail,
  upsertCustomer,
} from '../../src/customers/customer-repo.js';
import { createTestDb, seedTenantRow } from '../helpers/test-db.js';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 't1');
});

describe('upsertCustomer', () => {
  it('upserts by bsuid and fills wa_id later', async () => {
    const a = await upsertCustomer(db, 't1', { waId: null, bsuid: 'B1', profileName: 'Asha' });
    const b = await upsertCustomer(db, 't1', { waId: '919800000001', bsuid: 'B1', profileName: null });
    expect(b.id).toBe(a.id);
    expect(b.waKey).toBe('B1');
    expect(b.waId).toBe('919800000001');
    expect(b.profileName).toBe('Asha');
    expect(await db.select().from(customers)).toHaveLength(1);
  });

  it('uses waId as key when no bsuid', async () => {
    const c = await upsertCustomer(db, 't1', { waId: '919800000002', bsuid: null, profileName: null });
    expect(c.waKey).toBe('919800000002');
    expect(recipientOf(c)).toBe('919800000002');
  });

  it('recipientOf returns bsuid when no waId', async () => {
    const c = await upsertCustomer(db, 't1', { waId: null, bsuid: 'B2', profileName: null });
    expect(recipientOf(c)).toBe('B2');
  });

  it('throws when both ids are null', async () => {
    await expect(
      upsertCustomer(db, 't1', { waId: null, bsuid: null, profileName: 'x' }),
    ).rejects.toThrow();
  });

  it('does not overwrite profile_name with null but updates with new value', async () => {
    await upsertCustomer(db, 't1', { waId: '1', bsuid: null, profileName: 'Old' });
    const same = await upsertCustomer(db, 't1', { waId: '1', bsuid: null, profileName: null });
    expect(same.profileName).toBe('Old');
    const changed = await upsertCustomer(db, 't1', { waId: '1', bsuid: null, profileName: 'New' });
    expect(changed.profileName).toBe('New');
  });
});

describe('saveDefaultAddress / saveEmail', () => {
  it('persists address and email', async () => {
    const c = await upsertCustomer(db, 't1', { waId: '5', bsuid: null, profileName: null });
    const address = { name: 'Asha', line1: '12 MG Road', landmark: 'Near park', pincode: '560001' };
    await saveDefaultAddress(db, c.id, address);
    await saveEmail(db, c.id, 'a@example.com');
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(row!.defaultAddress).toEqual(address);
    expect(row!.email).toBe('a@example.com');
  });
});
