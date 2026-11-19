/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { orders, subscriptions } from '../../src/db/schema.js';
import { onChargeResult } from '../../src/subscriptions/charge-results.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';
import { seedCustomer, testTenant } from '../helpers/test-db.js';
import { MON_23_10AM, raisedCharge } from '../subscriptions/charge-fixture.js';

let t: AdminTest;
let auth: AdminLogin;
const tenant = testTenant();

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

const get = (path: string, a = auth) => t.app.request(`/admin${path}`, { headers: a.headers });
const post = (path: string, a = auth) => t.app.request(`/admin${path}`, { method: 'POST', headers: a.headers });
const charged = () => raisedCharge(t.db, { ...t.deps, now: () => MON_23_10AM }, tenant, t.pay, t.wa);

async function seedSub(tenantId: string, status: (typeof subscriptions.$inferInsert)['status'], createdAt: Date) {
  const c = await seedCustomer(t.db, tenantId, { profileName: `C-${status}` });
  const [s] = await t.db
    .insert(subscriptions)
    .values({ tenantId, customerId: c.id, status, address: { name: 'A', line1: 'x', pincode: '560035' } as any, pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 9000, createdAt })
    .returning();
  return s!;
}

describe('GET /admin/subscriptions', () => {
  it('requires a session', async () => {
    expect((await t.app.request('/admin/subscriptions')).status).toBe(401);
  });

  it('pages newest first, filters by status and hides other tenants', async () => {
    const a = await seedSub('test', 'active', new Date('2026-11-01T00:00:00Z'));
    const b = await seedSub('test', 'cancelled', new Date('2026-11-02T00:00:00Z'));
    const p = await seedSub('test', 'pending_authorization', new Date('2026-11-03T00:00:00Z'));
    await seedSub('other', 'active', new Date('2026-11-04T00:00:00Z'));

    const all = await (await get('/subscriptions')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((x: any) => x.id)).toEqual([p.id, b.id, a.id]);
    expect(all.items[2]).toMatchObject({ status: 'active', frequency: 'weekly', deliveryWeekday: 3, perDeliveryTotalPaise: 9000, customer: { profileName: 'C-active' } });

    const filtered = await (await get('/subscriptions?status=active,pending_authorization')).json();
    expect(filtered.items.map((x: any) => x.id)).toEqual([p.id, a.id]);

    const page2 = await (await get('/subscriptions?pageSize=2&page=2')).json();
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page2.items.map((x: any) => x.id)).toEqual([a.id]);
  });

  it('400 for an unknown status', async () => {
    expect((await get('/subscriptions?status=paused')).status).toBe(400);
  });
});

describe('GET /admin/subscriptions/:id', () => {
  it('shows items at current prices and charges with order codes', async () => {
    const { s, payment, order } = await charged();
    const res = await get(`/subscriptions/${s.id}`);
    expect(res.status).toBe(200);
    const { subscription } = await res.json();
    expect(subscription).toMatchObject({ id: s.id, status: 'active', nextDeliveryDate: '2026-12-02' });
    expect(subscription.items).toEqual([{ productId: expect.any(String), name: '12 pack', quantity: 1, unitPricePaise: 16800, active: true }]);
    expect(subscription.charges).toEqual([
      { id: payment.id, forDeliveryDate: '2026-11-25', amountPaise: 16800, status: 'created', orderId: order.id, orderCode: order.orderCode, createdAt: expect.any(String) },
    ]);
  });

  it('404 for another tenant, an unknown id or a non-uuid', async () => {
    const other = await seedSub('other', 'active', new Date());
    expect((await get(`/subscriptions/${other.id}`)).status).toBe(404);
    expect((await get('/subscriptions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/subscriptions/nope')).status).toBe(404);
  });
});

describe('POST /admin/subscriptions/:id/cancel', () => {
  it('cancels once at Cashfree; a repeat says already_cancelled', async () => {
    const { s, order } = await charged();
    const res = await post(`/subscriptions/${s.id}/cancel`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe('cancelled');
    expect(body.subscription).toMatchObject({ status: 'cancelled', nextDeliveryDate: null });
    expect(body.subscription.charges[0].status).toBe('cancelled');
    expect((await t.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe('cancelled');

    const again = await (await post(`/subscriptions/${s.id}/cancel`)).json();
    expect(again.result).toBe('already_cancelled');
    expect(t.pay.calls.filter((c) => c.method === 'cancelSubscription')).toHaveLength(1);
  });

  it('502 provider_error when Cashfree fails; nothing changes', async () => {
    const { s } = await charged();
    const { CashfreeError } = await import('../../src/payments/cashfree/client.js');
    t.pay.failNext = new CashfreeError('Cashfree request failed', 500, 'server_error');
    const res = await post(`/subscriptions/${s.id}/cancel`);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('provider_error');
    expect((await t.db.select().from(subscriptions).where(eq(subscriptions.id, s.id)))[0]!.status).toBe('active');
  });

  it("404 for another tenant's subscription, without calling Cashfree", async () => {
    const other = await seedSub('other', 'active', new Date());
    expect((await post(`/subscriptions/${other.id}/cancel`)).status).toBe(404);
    expect(t.pay.calls).toHaveLength(0);
  });
});

describe('subscription info on orders and customers', () => {
  it('a collected subscription order shows source, subscriptionId and paymentStatus paid; it stays off /orders/active until confirmed', async () => {
    const { s, payment, order, c } = await charged();
    const before = await (await get('/orders/active')).json();
    expect(before.items).toHaveLength(0);
    let view = (await (await get(`/orders/${order.id}`)).json()).order;
    expect(view).toMatchObject({ source: 'subscription', subscriptionId: s.id, paymentStatus: 'created', status: 'payment_pending' });

    t.pay.charges.set(payment.id, 'SUCCESS');
    await onChargeResult(t.deps, tenant, s.id, payment.id);
    view = (await (await get(`/orders/${order.id}`)).json()).order;
    expect(view).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    expect((await (await get('/orders/active')).json()).items.map((o: any) => o.id)).toEqual([order.id]);

    const cust = await (await get(`/customers/${c.id}`)).json();
    expect(cust.subscriptions.map((x: any) => x.id)).toEqual([s.id]);
  });

  it('one-time orders have subscriptionId null', async () => {
    const c = await seedCustomer(t.db, 'test');
    const [o] = await t.db
      .insert(orders)
      .values({ tenantId: 'test', orderCode: 'NF-ONE1', customerId: c.id, source: 'one_time', status: 'confirmed', deliveryDate: '2026-11-25', address: { name: 'A', line1: 'x', pincode: '560035' } as any, pincode: '560035', subtotalPaise: 9000, deliveryFeePaise: 0, totalPaise: 9000 })
      .returning();
    expect((await (await get(`/orders/${o!.id}`)).json()).order).toMatchObject({ subscriptionId: null, paymentStatus: null });
  });
});
