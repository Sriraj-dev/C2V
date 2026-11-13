import { afterEach, describe, it, expect } from 'vitest';
import {
  allTenants, registerTenants, resetTenantsForTests, tenantById, tenantByPhoneNumberId,
} from '../src/tenants/registry.js';
import { getTenantSettings } from '../src/tenants/settings-repo.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { createTestDb, seedTenantRow, testTenant } from './helpers/test-db.js';

afterEach(() => resetTenantsForTests());

describe('registry', () => {
  it('looks up by id and phone number id', () => {
    const t = testTenant();
    registerTenants([t]);
    expect(tenantById('test')).toBe(t);
    expect(tenantByPhoneNumberId(t.waPhoneNumberId)).toBe(t);
    expect(tenantByPhoneNumberId('nope')).toBeNull();
    expect(tenantById('nope')).toBeNull();
    expect(allTenants()).toEqual([t]);
  });
  it('throws on duplicate waPhoneNumberId', () => {
    expect(() => registerTenants([testTenant(), testTenant({ id: 'other' })])).toThrow(/phone/i);
  });
  it('throws on duplicate id', () => {
    expect(() => registerTenants([testTenant(), testTenant({ waPhoneNumberId: 'x' })])).toThrow(/id/i);
  });
  it('nutrifarm config registers cleanly', () => {
    registerTenants([nutrifarm]);
    expect(tenantByPhoneNumberId('1414838555047142')?.id).toBe('nutrifarm');
  });
});

describe('getTenantSettings', () => {
  it('returns values', async () => {
    const db = await createTestDb();
    await seedTenantRow(db, 'test', { supportPhone: '919999999999', deliveryFeePaise: 1500, minOrderPaise: 5000 });
    expect(await getTenantSettings(db, 'test')).toEqual({
      supportPhone: '919999999999', deliveryFeePaise: 1500, minOrderPaise: 5000,
    });
  });
  it('returns null supportPhone when column is null', async () => {
    const db = await createTestDb();
    await seedTenantRow(db, 'test', { supportPhone: null });
    expect((await getTenantSettings(db, 'test')).supportPhone).toBeNull();
  });
  it('throws when missing', async () => {
    const db = await createTestDb();
    await expect(getTenantSettings(db, 'ghost')).rejects.toThrow(/ghost/);
  });
});
