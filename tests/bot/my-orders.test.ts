import { beforeEach, describe, expect, it } from 'vitest';
import { orderStatusLabel, sendMyOrders, upcomingLabel } from '../../src/bot/my-orders.js';
import { handleInbound } from '../../src/bot/router.js';
import type { Db } from '../../src/db/client.js';
import { orders, subscriptionItems, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
const tenant = testTenant();
const text = (i = 0) => (wa.sent[i]!.message as any).text.body as string;

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 1000 });
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa });
});

async function order(customerId: string, status: any, code: string, createdAt: Date, tenantId = 'test') {
  await db.insert(orders).values({
    tenantId, orderCode: code, customerId, source: 'one_time', status, deliveryDate: '2026-01-07',
    address: { name: 'A', line1: 'x', pincode: '560035' } as any, pincode: '560035',
    subtotalPaise: 9000, deliveryFeePaise: 0, totalPaise: 9000, createdAt,
  });
}
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i));

describe('sendMyOrders', () => {
  it('lists the 5 newest orders newest first, without the pending note when nothing is pending', async () => {
    const c = await seedCustomer(db, 'test');
    for (let i = 0; i < 6; i++) await order(c.id, 'confirmed', `TS-C${i}`, at(i));
    await sendMyOrders(deps, tenant, c);
    expect(wa.sent).toHaveLength(1);
    const t = text();
    expect(['TS-C5', 'TS-C4', 'TS-C3', 'TS-C2', 'TS-C1'].map((k) => t.indexOf(k)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]!))).toBe(true);
    expect(t).not.toContain('TS-C0');
    expect(t).toContain('₹90');
    expect(t).not.toContain(tenant.copy.pendingPaymentNote());
  });

  it('shows a payment_pending order as Payment pending, with the Help note', async () => {
    const c = await seedCustomer(db, 'test');
    for (let i = 0; i < 5; i++) await order(c.id, 'confirmed', `TS-C${i}`, at(i));
    await order(c.id, 'payment_pending', 'TS-PEND', at(10));
    await sendMyOrders(deps, tenant, c);
    expect(wa.sent).toHaveLength(1);
    const t = text();
    expect(t.indexOf('TS-PEND')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('TS-PEND')).toBeLessThan(t.indexOf('TS-C4'));
    expect(t).toContain('Payment pending');
    expect(t).not.toContain('TS-C0');
    expect(t.endsWith(tenant.copy.pendingPaymentNote())).toBe(true);
  });

  it('no orders -> empty text then the menu', async () => {
    const c = await seedCustomer(db, 'test');
    await sendMyOrders(deps, tenant, c);
    expect(wa.sent).toHaveLength(2);
    expect(text()).toBe('No orders yet. Tap *Order Eggs* in the menu below to place your first order.');
    expect(wa.sent[1]!.message.type).toBe('interactive');
  });

  it('renders out_for_delivery as Out for delivery', async () => {
    const c = await seedCustomer(db, 'test');
    await order(c.id, 'out_for_delivery', 'TS-OFD', at(1));
    await sendMyOrders(deps, tenant, c);
    expect(text()).toContain('Out for delivery');
  });

  it('never shows another customer or tenant', async () => {
    const c = await seedCustomer(db, 'test');
    const other = await seedCustomer(db, 'test');
    await seedTenantRow(db, 'other');
    const oc = await seedCustomer(db, 'other');
    await order(other.id, 'confirmed', 'TS-OTHERCUST', at(1));
    await order(oc.id, 'confirmed', 'TS-OTHERTEN', at(2), 'other');
    await order(c.id, 'confirmed', 'TS-MINE', at(3));
    await sendMyOrders(deps, tenant, c);
    expect(text()).toContain('TS-MINE');
    expect(text()).not.toContain('TS-OTHER');
  });

  it('shows active subscriptions only', async () => {
    const c = await seedCustomer(db, 'test');
    const p = await seedProduct(db, 'test', { pricePaise: 9000 });
    for (const [status, day] of [['active', 3], ['cancelled', 5]] as const) {
      const [s] = await db.insert(subscriptions).values({
        tenantId: 'test', customerId: c.id, status, address: { name: 'A', line1: 'x', pincode: '560035' } as any,
        pincode: '560035', deliveryWeekday: day, perDeliveryTotalPaise: 0, nextDeliveryDate: status === 'active' ? '2026-01-07' : null,
      }).returning();
      await db.insert(subscriptionItems).values({ subscriptionId: s!.id, productId: p.id, quantity: 2 });
    }
    await sendMyOrders(deps, tenant, c);
    expect(wa.sent).toHaveLength(1);
    expect(text()).toContain('*Subscriptions*');
    expect(text()).toContain('₹190 every Wednesday (next: Wed, 7 Jan)');
    expect(text()).not.toContain('Friday');
  });

  it('excludes expired and payment_failed; shows cancelled and delivered with labels', async () => {
    const c = await seedCustomer(db, 'test');
    await order(c.id, 'expired', 'TS-EXP', at(1));
    await order(c.id, 'payment_failed', 'TS-FAIL', at(2));
    await order(c.id, 'cancelled', 'TS-CANC', at(3));
    await order(c.id, 'delivered', 'TS-DELI', at(4));
    await sendMyOrders(deps, tenant, c);
    const t = text();
    expect(t).not.toContain('TS-EXP');
    expect(t).not.toContain('TS-FAIL');
    expect(t).toMatch(/TS-CANC.*Cancelled/);
    expect(t).toMatch(/TS-DELI.*Delivered/);
  });

  it('hides other customers and tenants subscriptions; only-subscription sends one message', async () => {
    const c = await seedCustomer(db, 'test');
    const other = await seedCustomer(db, 'test');
    await seedTenantRow(db, 'other');
    const oc = await seedCustomer(db, 'other');
    const mk = (tenantId: string, customerId: string, day: number) =>
      db.insert(subscriptions).values({
        tenantId, customerId, status: 'active', address: { name: 'A', line1: 'x', pincode: '560035' } as any,
        pincode: '560035', deliveryWeekday: day, perDeliveryTotalPaise: 0, nextDeliveryDate: '2026-01-07',
      });
    await mk('test', c.id, 3);
    await mk('test', other.id, 5);
    await mk('other', oc.id, 6);
    await sendMyOrders(deps, tenant, c);
    expect(wa.sent).toHaveLength(1);
    expect(text()).toContain('Wednesday');
    expect(text()).not.toContain('Friday');
    expect(text()).not.toContain('Saturday');
  });

  it('pending next delivery shows pending', async () => {
    const c = await seedCustomer(db, 'test');
    await db.insert(subscriptions).values({
      tenantId: 'test', customerId: c.id, status: 'active', address: { name: 'A', line1: 'x', pincode: '560035' } as any,
      pincode: '560035', deliveryWeekday: 1, perDeliveryTotalPaise: 0,
    });
    await sendMyOrders(deps, tenant, c);
    expect(text()).toContain('(next: pending)');
  });

  it('biweekly subscription shows its schedule and next date', async () => {
    const c = await seedCustomer(db, 'test');
    const p = await seedProduct(db, 'test', { pricePaise: 9000 });
    const [s] = await db.insert(subscriptions).values({
      tenantId: 'test', customerId: c.id, status: 'active', frequency: 'biweekly', address: { name: 'A', line1: 'x', pincode: '560035' } as any,
      pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 0, nextDeliveryDate: '2026-12-02',
    }).returning();
    await db.insert(subscriptionItems).values({ subscriptionId: s!.id, productId: p.id, quantity: 1 });
    await sendMyOrders(deps, tenant, c);
    expect(text()).toContain('every 2 weeks on Wednesday (next: Wed, 2 Dec)');
  });

  it('an upcoming subscription order shows Upcoming · payment tomorrow, without the pay-link note', async () => {
    deps = testDeps({ db, whatsapp: wa, now: () => new Date('2026-11-23T04:30:00Z') }); // Mon, D-2 for Wed 25 Nov
    const c = await seedCustomer(db, 'test');
    await db.insert(orders).values({
      tenantId: 'test', orderCode: 'NF-UP1', customerId: c.id, source: 'subscription', status: 'payment_pending', deliveryDate: '2026-11-25',
      address: { name: 'A', line1: 'x', pincode: '560035' } as any, pincode: '560035', subtotalPaise: 9000, deliveryFeePaise: 0, totalPaise: 9000,
    });
    await sendMyOrders(deps, tenant, c);
    expect(text()).toContain('NF-UP1 — Upcoming · payment tomorrow — Wed, 25 Nov');
    expect(text()).not.toContain(tenant.copy.pendingPaymentNote());
  });

  it('upcomingLabel says today on the collection day', () => {
    expect(upcomingLabel('2026-11-25', '2026-11-23')).toBe('Upcoming · payment tomorrow');
    expect(upcomingLabel('2026-11-25', '2026-11-24')).toBe('Upcoming · payment today');
  });

  it('router routes the My Orders button here', async () => {
    await handleInbound(deps, tenant, {
      kind: 'button', replyId: 'menu:my_orders', title: 'My Orders', phoneNumberId: 'p', waMessageId: 'w1', timestamp: 1,
      from: { waId: '919811112222', bsuid: null, profileName: null }, raw: {},
    } as any);
    expect(text()).toContain('No orders yet');
  });
});

describe('orderStatusLabel', () => {
  it('maps known and unknown statuses', () => {
    expect(orderStatusLabel('confirmed')).toBe('Confirmed');
    expect(orderStatusLabel('assigned')).toBe('Assigned to delivery partner');
    expect(orderStatusLabel('out_for_delivery')).toBe('Out for delivery');
    expect(orderStatusLabel('delivered')).toBe('Delivered');
    expect(orderStatusLabel('cancelled')).toBe('Cancelled');
    expect(orderStatusLabel('on_hold_now')).toBe('On hold now');
  });
});
