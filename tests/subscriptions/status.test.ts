/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { orders, payments, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { onSubscriptionStatus } from '../../src/subscriptions/subscription-service.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../helpers/test-db.js';

let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
let now: Date;
const tenant = testTenant();
// Mon 16 Nov 2026 10:00 IST.
const MON_10AM = new Date('2026-11-16T04:30:00Z');

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0 });
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  now = MON_10AM;
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => now });
});

const address = { name: 'Asha', line1: '12 MG Rd', landmark: '', pincode: '560035' } as any;

async function seedSub(status: 'pending_authorization' | 'active' | 'cancelled' | 'authorization_failed', nextDeliveryDate: string | null = null) {
  const c = await seedCustomer(db, 'test', { waId: '919811112222' });
  const [s] = await db
    .insert(subscriptions)
    .values({ tenantId: 'test', customerId: c.id, status, frequency: 'biweekly', address, pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 18000, nextDeliveryDate })
    .returning();
  return { c, s: s! };
}

/** An upcoming subscription order (payment_pending) with its raised, not yet collected charge. */
async function seedUpcomingCharge(subscriptionId: string, customerId: string, date = '2026-11-25') {
  const [o] = await db
    .insert(orders)
    .values({ tenantId: 'test', orderCode: 'NF-UP1', customerId, source: 'subscription', subscriptionId, status: 'payment_pending', deliveryDate: date, address, pincode: '560035', subtotalPaise: 18000, deliveryFeePaise: 0, totalPaise: 18000 })
    .returning();
  const [p] = await db
    .insert(payments)
    .values({ tenantId: 'test', orderId: o!.id, subscriptionId, forDeliveryDate: date, kind: 'subscription_charge', providerRef: 'pay-1', amountPaise: 18000, status: 'created' })
    .returning();
  pay.charges.set('pay-1', 'INITIALIZED');
  return { o: o!, p: p! };
}

const subRow = async (id: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
const texts = () => wa.sent.map((m) => (m.message as any).text?.body as string);

describe('onSubscriptionStatus', () => {
  it('ACTIVE twice activates once, sets the first delivery and sends one message', async () => {
    const { s } = await seedSub('pending_authorization');
    pay.setSubscription(s.id, 'ACTIVE', 'ACTIVE');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('activated');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('unchanged');
    expect(await subRow(s.id)).toMatchObject({ status: 'active', nextDeliveryDate: '2026-11-18' });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('every 2 weeks on Wednesday');
    expect(texts()[0]).toContain('Wed, 18 Nov');
  });

  it('activation at 20:30 IST two days before the weekday starts a week later', async () => {
    now = new Date('2026-11-16T15:00:00Z'); // Mon 20:30 IST
    const { s } = await seedSub('pending_authorization');
    pay.setSubscription(s.id, 'ACTIVE', 'ACTIVE');
    await onSubscriptionStatus(deps, tenant, s.id);
    expect((await subRow(s.id)).nextDeliveryDate).toBe('2026-11-25');
  });

  it('auth FAILED while pending → authorization_failed and the try-again message, once', async () => {
    const { s } = await seedSub('pending_authorization');
    pay.setSubscription(s.id, 'INITIALIZED', 'FAILED');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('auth_failed');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('unchanged');
    expect((await subRow(s.id)).status).toBe('authorization_failed');
    expect(texts()).toEqual([tenant.copy.subscriptionAuthFailed()]);
  });

  it('LINK_EXPIRED while pending → authorization_failed', async () => {
    const { s } = await seedSub('pending_authorization');
    pay.setSubscription(s.id, 'LINK_EXPIRED');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('auth_failed');
  });

  it('CUSTOMER_CANCELLED on active cancels it, its open charge and the upcoming order', async () => {
    const { c, s } = await seedSub('active', '2026-11-25');
    const { o, p } = await seedUpcomingCharge(s.id, c.id);
    pay.setSubscription(s.id, 'CUSTOMER_CANCELLED', 'ACTIVE');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('cancelled');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('unchanged');
    expect(await subRow(s.id)).toMatchObject({ status: 'cancelled', nextDeliveryDate: null });
    expect(pay.calls.filter((x) => x.method === 'cancelCharge')).toEqual([{ method: 'cancelCharge', subscriptionId: s.id, paymentId: 'pay-1' }]);
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]!.status).toBe('cancelled');
    expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0]!.status).toBe('cancelled');
    expect(texts()).toEqual([tenant.copy.subscriptionCancelled()]);
  });

  it('a charge Cashfree refuses to cancel is left as is; the subscription is still cancelled', async () => {
    const { c, s } = await seedSub('active', '2026-11-25');
    const { o, p } = await seedUpcomingCharge(s.id, c.id);
    pay.refuseCancelCharge = new Error('payment_status_invalid_for_action');
    pay.setSubscription(s.id, 'CANCELLED');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('cancelled');
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]!.status).toBe('created');
    expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0]!.status).toBe('payment_pending');
  });

  it('webhook says ACTIVE but re-fetch says INITIALIZED → nothing changes', async () => {
    const { s } = await seedSub('pending_authorization');
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('unchanged');
    expect((await subRow(s.id)).status).toBe('pending_authorization');
    expect(wa.sent).toHaveLength(0);
  });

  it.each(['CUSTOMER_PAUSED', 'BANK_APPROVAL_PENDING'])('%s on active → unchanged', async (st) => {
    const { s } = await seedSub('active', '2026-11-25');
    pay.setSubscription(s.id, st);
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('unchanged');
    expect(await subRow(s.id)).toMatchObject({ status: 'active', nextDeliveryDate: '2026-11-25' });
  });

  it('a send failure does not undo the activation', async () => {
    const { s } = await seedSub('pending_authorization');
    pay.setSubscription(s.id, 'ACTIVE', 'ACTIVE');
    wa.failNext = new Error("wa down");
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('activated');
    expect((await subRow(s.id)).status).toBe('active');
  });

  it('an unknown or other-tenant id → unchanged without calling Cashfree', async () => {
    expect(await onSubscriptionStatus(deps, tenant, '00000000-0000-4000-8000-000000000000')).toBe('unchanged');
    expect(pay.calls).toHaveLength(0);
  });
});
