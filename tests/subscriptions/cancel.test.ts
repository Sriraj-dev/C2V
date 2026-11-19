/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { orders, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { cancelSubscription } from '../../src/subscriptions/subscription-service.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../helpers/test-db.js';
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

const subRow = async (id: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
const calls = (m: string) => pay.calls.filter((x) => x.method === m);
const texts = () => wa.sent.map((m) => (m.message as any).text?.body as string);

describe('cancelSubscription', () => {
  it('active with an upcoming charge → Cashfree cancel, charge and upcoming order cancelled, one message', async () => {
    const { s, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    expect(await cancelSubscription(deps, tenant, s.id)).toBe('cancelled');
    expect(calls('cancelSubscription')).toHaveLength(1);
    expect(calls('cancelCharge')).toHaveLength(1);
    expect(await subRow(s.id)).toMatchObject({ status: 'cancelled', nextDeliveryDate: null });
    expect(await paymentStatus(db, payment.id)).toBe('cancelled');
    expect((await orderOf(db, order.id)).status).toBe('cancelled');
    expect(texts()).toEqual([tenant.copy.subscriptionCancelled()]);
  });

  it('twice → already_cancelled, no second Cashfree call or message', async () => {
    const { s } = await raisedCharge(db, deps, tenant, pay, wa);
    await cancelSubscription(deps, tenant, s.id);
    expect(await cancelSubscription(deps, tenant, s.id)).toBe('already_cancelled');
    expect(calls('cancelSubscription')).toHaveLength(1);
    expect(wa.sent).toHaveLength(1);
  });

  it('Cashfree error → throws, nothing changes', async () => {
    const { s, payment } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.failNext = new Error('cashfree down');
    await expect(cancelSubscription(deps, tenant, s.id)).rejects.toThrow('cashfree down');
    expect(await subRow(s.id)).toMatchObject({ status: 'active', nextDeliveryDate: '2026-12-02' });
    expect(await paymentStatus(db, payment.id)).toBe('created');
    expect(wa.sent).toHaveLength(0);
  });

  it('a confirmed order is left alone', async () => {
    const { s, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(order.id, 'SUCCESS');
    await db.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, order.id));
    pay.refuseCancelCharge = new Error('payment_status_invalid_for_action');
    expect(await cancelSubscription(deps, tenant, s.id)).toBe('cancelled');
    expect((await orderOf(db, order.id)).status).toBe('confirmed');
  });

  it('a pending-authorisation subscription can be cancelled', async () => {
    const c = await seedCustomer(db, 'test', { waId: '919811112222' });
    const [s] = await db
      .insert(subscriptions)
      .values({ tenantId: 'test', customerId: c.id, status: 'pending_authorization', address: { name: 'A', line1: 'x', pincode: '560035' } as any, pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 9000 })
      .returning();
    expect(await cancelSubscription(deps, tenant, s!.id)).toBe('cancelled');
    expect((await subRow(s!.id)).status).toBe('cancelled');
  });

  it("another tenant's subscription → not found", async () => {
    const { s } = await raisedCharge(db, deps, tenant, pay, wa);
    await expect(cancelSubscription(deps, testTenant({ id: 'other' }), s.id)).rejects.toThrow('not found');
    expect(calls('cancelSubscription')).toHaveLength(0);
  });
});
