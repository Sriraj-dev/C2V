/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { orders } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { onChargeResult } from '../../src/subscriptions/charge-results.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedTenantRow, testTenant } from '../helpers/test-db.js';
import { MON_23_10AM, orderOf, paymentStatus, raisedCharge } from './charge-fixture.js';

let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
const tenant = testTenant();

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0 });
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => MON_23_10AM });
});

describe('onChargeResult', () => {
  it('success twice → order confirmed once with paid_at, payment paid, one order for the cycle, no message', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'SUCCESS');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('confirmed');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('unchanged');
    expect(await paymentStatus(db, payment.id)).toBe('paid');
    const o = await orderOf(db, order.id);
    expect(o.status).toBe('confirmed');
    expect(o.paidAt).not.toBeNull();
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(wa.sent).toHaveLength(0);
  });

  it('failure → order payment_failed and one charge-failed template; a repeat sends none', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'FAILED');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('failed');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('unchanged');
    expect(await paymentStatus(db, payment.id)).toBe('failed');
    expect((await orderOf(db, order.id)).status).toBe('payment_failed');
    expect(wa.sent.map((m) => (m.message as any).template)).toEqual([
      { name: 'subscription_charge_failed', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Wed, 25 Nov' }] }] },
    ]);
  });

  it('success after a local failure (UPI retry collected) → order confirmed', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'FAILED');
    await onChargeResult(deps, tenant, s.id, payment.id);
    pay.charges.set(payment.id, 'SUCCESS');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('confirmed');
    expect((await orderOf(db, order.id)).status).toBe('confirmed');
  });

  it('cancelled → payment and order cancelled', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'CANCELLED');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('cancelled');
    expect(await paymentStatus(db, payment.id)).toBe('cancelled');
    expect((await orderOf(db, order.id)).status).toBe('cancelled');
  });

  it('webhook body says success but Cashfree still says PENDING → unchanged', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'PENDING');
    expect(await onChargeResult(deps, tenant, s.id, payment.id)).toBe('unchanged');
    expect((await orderOf(db, order.id)).status).toBe('payment_pending');
  });

  it('unknown payment id, non-uuid, or a payment of another subscription → unchanged', async () => {
    const { s, payment } = await raisedCharge(db, deps, tenant, pay, wa);
    expect(await onChargeResult(deps, tenant, s.id, '00000000-0000-4000-8000-000000000000')).toBe('unchanged');
    expect(await onChargeResult(deps, tenant, s.id, 'cf_123')).toBe('unchanged');
    expect(await onChargeResult(deps, tenant, '00000000-0000-4000-8000-000000000001', payment.id)).toBe('unchanged');
    expect(pay.calls).toHaveLength(0);
  });
});
