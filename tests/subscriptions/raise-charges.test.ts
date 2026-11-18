/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveOrders } from '../../src/admin/orders/queries.js';
import type { Db } from '../../src/db/client.js';
import { orderItems, orders, payments, products, subscriptionItems, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { raiseDueCharges } from '../../src/subscriptions/charges.js';
import { onSubscriptionStatus } from '../../src/subscriptions/subscription-service.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
let now: Date;
const tenant = testTenant();
const noSleep = { sleep: async () => {} };
const at = (iso: string) => (now = new Date(iso));
const MON_23_10AM = '2026-11-23T04:30:00Z';

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 3000, minOrderPaise: 0 });
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  now = new Date(MON_23_10AM);
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => now });
});

const address = { name: 'Asha', line1: '12 MG Rd', pincode: '560035' } as any;

/** Active Wednesday subscription: 2 × 6 pack (₹90) + 1 × 12 pack (₹168), next delivery Wed 25 Nov by default. */
async function seedSub(o: { frequency?: 'weekly' | 'biweekly' | 'monthly'; next?: string } = {}) {
  const p6 = await seedProduct(db, 'test', { name: '6 pack', pricePaise: 9000 });
  const p12 = await seedProduct(db, 'test', { name: '12 pack', pricePaise: 16800 });
  const c = await seedCustomer(db, 'test', { waId: '919811112222' });
  const [s] = await db
    .insert(subscriptions)
    .values({ tenantId: 'test', customerId: c.id, status: 'active', frequency: o.frequency ?? 'weekly', address, pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 37800, nextDeliveryDate: o.next ?? '2026-11-25' })
    .returning();
  await db.insert(subscriptionItems).values([
    { subscriptionId: s!.id, productId: p6.id, quantity: 2 },
    { subscriptionId: s!.id, productId: p12.id, quantity: 1 },
  ]);
  pay.setSubscription(s!.id, 'ACTIVE', 'ACTIVE');
  return { s: s!, c, p6, p12 };
}

const nextDate = async (id: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!.nextDeliveryDate;
const raises = () => pay.calls.filter((x) => x.method === 'raiseCharge').map((x: any) => x.input);
const templates = () => wa.sent.filter((m) => m.message.type === 'template').map((m) => (m.message as any).template);
const run = () => raiseDueCharges(deps, tenant, noSleep);

describe('raiseDueCharges', () => {
  it('on D-3 (Sun 22 Nov) nothing is raised', async () => {
    at('2026-11-22T04:30:00Z');
    const { s } = await seedSub();
    expect(await run()).toEqual({ raised: 0, skipped: 0, failed: 0 });
    expect(await nextDate(s.id)).toBe('2026-11-25');
    expect(pay.calls).toHaveLength(0);
  });

  it('on D-2 creates the upcoming order and payment, raises for D-1, advances the date and sends the template', async () => {
    const { s } = await seedSub();
    expect(await run()).toEqual({ raised: 1, skipped: 0, failed: 0 });
    const [o] = await db.select().from(orders);
    expect(o).toMatchObject({ status: 'payment_pending', source: 'subscription', subscriptionId: s.id, deliveryDate: '2026-11-25', subtotalPaise: 34800, deliveryFeePaise: 3000, totalPaise: 37800 });
    const [p] = await db.select().from(payments);
    expect(p).toMatchObject({ orderId: o!.id, subscriptionId: s.id, forDeliveryDate: '2026-11-25', kind: 'subscription_charge', status: 'created', amountPaise: 37800, providerRef: p!.id });
    expect(p!.chargeItems).toHaveLength(2);
    expect(raises()).toEqual([{ subscriptionId: s.id, paymentId: p!.id, amountPaise: 37800, scheduleDate: '2026-11-24' }]);
    expect(await nextDate(s.id)).toBe('2026-12-02');
    expect(templates()).toEqual([
      {
        name: 'subscription_upcoming_charge',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '378' }, { type: 'text', text: 'Wed, 25 Nov' }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `skip:${p!.id}` }] },
        ],
      },
    ]);
  });

  it('running again the same day adds nothing', async () => {
    await seedSub();
    await run();
    expect(await run()).toEqual({ raised: 0, skipped: 0, failed: 0 });
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(raises()).toHaveLength(1);
    expect(templates()).toHaveLength(1);
  });

  it('a charge raised by a run that stopped before moving the date on is not raised again', async () => {
    const { s } = await seedSub();
    await run();
    await db.update(subscriptions).set({ nextDeliveryDate: '2026-11-25' }).where(eq(subscriptions.id, s.id));
    expect(await run()).toEqual({ raised: 0, skipped: 0, failed: 0 });
    expect(raises()).toHaveLength(1);
    expect(await nextDate(s.id)).toBe('2026-12-02');
  });

  it('D = tomorrow (missed D-2) → charge scheduled for D', async () => {
    at('2026-11-24T04:30:00Z');
    await seedSub();
    await run();
    expect(raises()[0].scheduleDate).toBe('2026-11-25');
  });

  it('D = today → cycle skipped, no order or charge, date moves to next week', async () => {
    at('2026-11-25T04:30:00Z');
    const { s } = await seedSub();
    expect(await run()).toEqual({ raised: 0, skipped: 1, failed: 0 });
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(raises()).toHaveLength(0);
    expect(await nextDate(s.id)).toBe('2026-12-02');
  });

  it.each([
    ['biweekly', '2026-12-09'],
    ['monthly', '2026-12-23'],
  ] as const)('%s advances by its step', async (frequency, expected) => {
    const { s } = await seedSub({ frequency });
    await run();
    expect(await nextDate(s.id)).toBe(expected);
  });

  it('monthly rolls over the year', async () => {
    at('2026-12-28T04:30:00Z');
    const { s } = await seedSub({ frequency: 'monthly', next: '2026-12-30' });
    await run();
    expect(await nextDate(s.id)).toBe('2027-01-27');
  });

  it('uses current prices and drops deactivated products', async () => {
    const { p6, p12 } = await seedSub();
    await db.update(products).set({ pricePaise: 10000 }).where(eq(products.id, p6.id));
    await db.update(products).set({ active: false }).where(eq(products.id, p12.id));
    await run();
    const [o] = await db.select().from(orders);
    expect(o).toMatchObject({ subtotalPaise: 20000, totalPaise: 23000 });
    expect(await db.select().from(orderItems)).toHaveLength(1);
    expect(raises()[0].amountPaise).toBe(23000);
  });

  it('all products deactivated → skipped, no ₹0 charge and no order', async () => {
    const { s } = await seedSub();
    await db.update(products).set({ active: false });
    expect(await run()).toEqual({ raised: 0, skipped: 1, failed: 0 });
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(raises()).toHaveLength(0);
    expect(await nextDate(s.id)).toBe('2026-12-02');
  });

  it('paused from the UPI app → skipped, date advances, no charge', async () => {
    const { s } = await seedSub();
    pay.setSubscription(s.id, 'CUSTOMER_PAUSED', 'ACTIVE');
    expect(await run()).toEqual({ raised: 0, skipped: 1, failed: 0 });
    expect(raises()).toHaveLength(0);
    expect(await nextDate(s.id)).toBe('2026-12-02');
  });

  it('a transient Cashfree error is retried within the run', async () => {
    await seedSub();
    let calls = 0;
    const orig = pay.raiseCharge.bind(pay);
    pay.raiseCharge = async (t, i) => {
      if (++calls < 3) throw new Error('cashfree 502');
      return orig(t, i);
    };
    expect(await run()).toEqual({ raised: 1, skipped: 0, failed: 0 });
  });

  it('raise failing on every attempt → no payment or order left, date unchanged, no message', async () => {
    const { s } = await seedSub();
    pay.raiseCharge = async () => {
      throw new Error('cashfree down');
    };
    pay.getCharge = async () => {
      throw new Error('not found');
    };
    expect(await run()).toEqual({ raised: 0, skipped: 0, failed: 1 });
    expect(await db.select().from(payments)).toHaveLength(0);
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(orderItems)).toHaveLength(0);
    expect(await nextDate(s.id)).toBe('2026-11-25');
    expect(wa.sent).toHaveLength(0);
  });

  it('raise errored but the charge exists at Cashfree → kept as raised', async () => {
    await seedSub();
    pay.raiseCharge = async () => {
      throw new Error('timeout');
    };
    expect(await run()).toEqual({ raised: 1, skipped: 0, failed: 0 });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it('a template send failure is logged; the charge stays raised', async () => {
    await seedSub();
    wa.failNext = new Error('wa down');
    expect(await run()).toEqual({ raised: 1, skipped: 0, failed: 0 });
  });

  it('the upcoming order is not in the active orders list', async () => {
    await seedSub();
    await run();
    expect(await listActiveOrders(db, 'test')).toHaveLength(0);
  });

  it('activation after the day\'s run with D two days away raises the first charge straight away', async () => {
    at('2026-11-23T09:30:00Z'); // Mon 15:00 IST
    const { s } = await seedSub({ next: undefined });
    await db.update(subscriptions).set({ status: 'pending_authorization', nextDeliveryDate: null }).where(eq(subscriptions.id, s.id));
    expect(await onSubscriptionStatus(deps, tenant, s.id)).toBe('activated');
    expect(raises()).toEqual([expect.objectContaining({ scheduleDate: '2026-11-24' })]);
    expect(await nextDate(s.id)).toBe('2026-12-02');
    expect(wa.sent.map((m) => m.message.type)).toEqual(['text', 'template']);
  });
});
