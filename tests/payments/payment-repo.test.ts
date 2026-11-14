import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { findPaymentByProviderRef, insertPayment, markPayment } from '../../src/payments/payment-repo.js';
import { createTestDb, seedTenantRow } from '../helpers/test-db.js';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  await seedTenantRow(db, 'other');
});

const row = { tenantId: 'test', kind: 'link' as const, providerRef: 'c2v_ord_1', amountPaise: 48000, status: 'created' as const, linkUrl: 'https://u' };

describe('payment repo', () => {
  it('inserts and finds by provider ref (with and without tenant)', async () => {
    const p = await insertPayment(db, row);
    expect(p).toMatchObject({ provider: 'cashfree', status: 'created', amountPaise: 48000 });
    expect((await findPaymentByProviderRef(db, undefined, 'c2v_ord_1'))?.id).toBe(p.id);
    expect((await findPaymentByProviderRef(db, 'test', 'c2v_ord_1'))?.id).toBe(p.id);
    expect(await findPaymentByProviderRef(db, 'other', 'c2v_ord_1')).toBeNull();
    expect(await findPaymentByProviderRef(db, undefined, 'nope')).toBeNull();
  });
  it('rejects a duplicate provider ref', async () => {
    await insertPayment(db, row);
    await expect(insertPayment(db, row)).rejects.toThrow();
  });
  it('marks status and stores raw', async () => {
    const p = await insertPayment(db, row);
    const updated = await markPayment(db, p.id, 'paid', { link_status: 'PAID' });
    expect(updated).toMatchObject({ status: 'paid', raw: { link_status: 'PAID' } });
    expect(await markPayment(db, '00000000-0000-0000-0000-000000000000', 'paid', {})).toBeNull();
  });
});
