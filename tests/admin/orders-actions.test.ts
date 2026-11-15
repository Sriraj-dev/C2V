import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { deliveryPartners, orderItems, orders, payments } from '../../src/db/schema.js';
import { ProviderError } from '../../src/payments/provider.js';
import { WhatsAppSendError } from '../../src/channels/whatsapp/sender.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';
import { seedCustomer, seedProduct } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: AdminTest;
let auth: AdminLogin;
let n = 0;

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

async function seedOrder(
  status: (typeof orders.$inferInsert)['status'],
  o: {
    tenantId?: string;
    code?: string;
    deliveryDate?: string;
    payment?: 'paid' | 'created' | 'refunded' | null;
    waId?: string | null;
    phone?: string;
    partnerId?: string;
    pincode?: string;
    location?: { lat: number; lng: number } | null;
    createdAt?: Date;
  } = {},
) {
  const tenantId = o.tenantId ?? 'test';
  n++;
  const c = await seedCustomer(t.db, tenantId, {
    waId: o.waId === undefined ? `9198111${String(10000 + n)}` : o.waId,
    ...(o.waId === null ? { waKey: `bsuid-${n}`, bsuid: `bsuid-${n}` } : {}),
    profileName: `Cust ${n}`,
  } as any);
  const pin = o.pincode ?? '560035';
  const [order] = await t.db
    .insert(orders)
    .values({
      tenantId,
      orderCode: o.code ?? `NF-${n}AAAA`,
      customerId: c.id,
      source: 'one_time',
      status,
      deliveryDate: o.deliveryDate ?? '2026-11-18',
      address: { name: 'Asha', line1: 'x', pincode: pin, ...(o.phone ? { phone: o.phone } : {}) } as any,
      location: o.location ?? null,
      pincode: pin,
      subtotalPaise: 60000,
      deliveryFeePaise: 0,
      totalPaise: 60000,
      assignedPartnerId: o.partnerId ?? null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  const p = await seedProduct(t.db, tenantId);
  await t.db.insert(orderItems).values({
    orderId: order!.id,
    productId: p.id,
    name: p.name,
    unitPricePaise: 30000,
    quantity: 2,
    lineTotalPaise: 60000,
  });
  const ps = o.payment === undefined ? 'paid' : o.payment;
  if (ps) {
    await t.db.insert(payments).values({
      tenantId,
      orderId: order!.id,
      kind: 'link',
      status: ps,
      providerRef: order!.id,
      amountPaise: 60000,
    });
  }
  return order!;
}


const post = (path: string, body?: unknown, headers: Record<string, string> = auth.headers) =>
  t.app.request(path, {
    method: 'POST',
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function seedPartner(o: { tenantId?: string; active?: boolean; name?: string } = {}) {
  n++;
  const [p] = await t.db
    .insert(deliveryPartners)
    .values({ tenantId: o.tenantId ?? 'test', name: o.name ?? 'Ravi', phone: `91980000${String(1000 + n)}`, active: o.active ?? true })
    .returning();
  return p!;
}
const reload = async (id: string) => (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
const payOf = async (orderId: string) => (await t.db.select().from(payments).where(eq(payments.orderId, orderId)))[0]!;

describe('assign', () => {
  it('assigns a confirmed order, then reassigns', async () => {
    const o = await seedOrder('confirmed');
    const a = await seedPartner();
    const b = await seedPartner({ name: 'Sita' });
    const r1 = await post(`/admin/orders/${o.id}/assign`, { partnerId: a.id });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as any;
    expect(j1.order.status).toBe('assigned');
    expect(j1.order.partner.id).toBe(a.id);
    const r2 = await post(`/admin/orders/${o.id}/assign`, { partnerId: b.id });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).order.partner.id).toBe(b.id);
  });

  it('409 partner_unavailable for inactive or foreign partner', async () => {
    const o = await seedOrder('confirmed');
    const inactive = await seedPartner({ active: false });
    const foreign = await seedPartner({ tenantId: 'other' });
    for (const p of [inactive, foreign]) {
      const r = await post(`/admin/orders/${o.id}/assign`, { partnerId: p.id });
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error.code).toBe('partner_unavailable');
    }
    expect((await reload(o.id)).status).toBe('confirmed');
  });

  it('400 without partnerId or with a bad one', async () => {
    const o = await seedOrder('confirmed');
    for (const body of [{}, { partnerId: 'nope' }]) {
      const r = await post(`/admin/orders/${o.id}/assign`, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe('validation_error');
    }
  });

  it('409 invalid_transition from delivered', async () => {
    const o = await seedOrder('delivered');
    const p = await seedPartner();
    const r = await post(`/admin/orders/${o.id}/assign`, { partnerId: p.id });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('invalid_transition');
  });
});

describe('out-for-delivery / delivered / cancel', () => {
  it('out-for-delivery from confirmed is 409; from assigned works', async () => {
    const c = await seedOrder('confirmed');
    const r = await post(`/admin/orders/${c.id}/out-for-delivery`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('invalid_transition');
    const a = await seedOrder('assigned');
    const ok = await post(`/admin/orders/${a.id}/out-for-delivery`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).order.status).toBe('out_for_delivery');
  });

  it('delivered notifies via order_delivered template', async () => {
    const o = await seedOrder('out_for_delivery');
    const r = await post(`/admin/orders/${o.id}/delivered`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.notified).toBe(true);
    expect(j.order.status).toBe('delivered');
    expect((t.wa.sent[0]!.message as any).template.name).toBe('order_delivered');
  });

  it('delivered with WhatsApp failure is 200 notified:false', async () => {
    const o = await seedOrder('out_for_delivery');
    t.wa.failNext = new WhatsAppSendError(500, undefined, 'boom', undefined);
    const r = await post(`/admin/orders/${o.id}/delivered`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.notified).toBe(false);
    expect(j.order.status).toBe('delivered');
  });

  it('cancel keeps paymentStatus paid; cancel delivered is 409', async () => {
    const o = await seedOrder('confirmed');
    const r = await post(`/admin/orders/${o.id}/cancel`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.order.status).toBe('cancelled');
    expect(j.order.paymentStatus).toBe('paid');
    const d = await seedOrder('delivered');
    expect((await post(`/admin/orders/${d.id}/cancel`)).status).toBe(409);
  });
});

describe('refund', () => {
  it('refunds a paid order, then reports already_refunded', async () => {
    const o = await seedOrder('confirmed');
    const r = await post(`/admin/orders/${o.id}/refund`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.result).toBe('refunded');
    expect(j.order.paymentStatus).toBe('refunded');
    expect(j.order.status).toBe('cancelled');
    const r2 = await post(`/admin/orders/${o.id}/refund`);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).result).toBe('already_refunded');
  });

  it('409 refund_not_possible for unpaid or payment-less orders', async () => {
    const u = await seedOrder('payment_pending', { payment: 'created' });
    const r = await post(`/admin/orders/${u.id}/refund`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('refund_not_possible');
    const np = await seedOrder('confirmed', { payment: null });
    expect(((await (await post(`/admin/orders/${np.id}/refund`)).json()) as any).error.code).toBe('refund_not_possible');
  });

  it('502 provider_error leaves payment paid', async () => {
    const o = await seedOrder('confirmed');
    t.pay.failNext = new ProviderError('x');
    const r = await post(`/admin/orders/${o.id}/refund`);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe('provider_error');
    expect((await payOf(o.id)).status).toBe('paid');
    expect((await reload(o.id)).status).toBe('confirmed');
  });
});

describe('tenant isolation and ids', () => {
  it('every action on another tenant order is 404 and changes nothing', async () => {
    const o = await seedOrder('assigned', { tenantId: 'other' });
    const p = await seedPartner();
    const calls: [string, unknown?][] = [
      ['assign', { partnerId: p.id }],
      ['out-for-delivery'],
      ['delivered'],
      ['cancel'],
      ['refund'],
    ];
    for (const [action, body] of calls) {
      const r = await post(`/admin/orders/${o.id}/${action}`, body);
      expect(r.status, action).toBe(404);
      expect(((await r.json()) as any).error.code).toBe('not_found');
    }
    expect((await reload(o.id)).status).toBe('assigned');
    expect((await payOf(o.id)).status).toBe('paid');
  });

  it('non-uuid id is 404 on action routes', async () => {
    for (const action of ['out-for-delivery', 'delivered', 'cancel', 'refund']) {
      expect((await post(`/admin/orders/not-a-uuid/${action}`)).status).toBe(404);
    }
    const p = await seedPartner();
    expect((await post('/admin/orders/not-a-uuid/assign', { partnerId: p.id })).status).toBe(404);
  });

  it('requires a session', async () => {
    const o = await seedOrder('confirmed');
    expect((await post(`/admin/orders/${o.id}/cancel`, undefined, {})).status).toBe(401);
  });
});

describe('bulk-assign', () => {
  it('returns per-order results in input order, deduped', async () => {
    const ok = await seedOrder('confirmed');
    const bad = await seedOrder('delivered');
    const foreign = await seedOrder('confirmed', { tenantId: 'other' });
    const p = await seedPartner();
    const r = await post('/admin/orders/bulk-assign', { orderIds: [ok.id, bad.id, foreign.id, ok.id], partnerId: p.id });
    expect(r.status).toBe(200);
    const { results } = (await r.json()) as any;
    expect(results).toHaveLength(3);
    expect(results.map((x: any) => x.orderId)).toEqual([ok.id, bad.id, foreign.id]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0].order.status).toBe('assigned');
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'invalid_transition' } });
    expect(results[2]).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect((await reload(foreign.id)).status).toBe('confirmed');
  });

  it('reports partner_unavailable per order', async () => {
    const o = await seedOrder('confirmed');
    const p = await seedPartner({ active: false });
    const { results } = (await (await post('/admin/orders/bulk-assign', { orderIds: [o.id], partnerId: p.id })).json()) as any;
    expect(results[0].error.code).toBe('partner_unavailable');
  });

  it('400 for empty, 101, non-uuid ids or missing partner', async () => {
    const p = await seedPartner();
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    for (const body of [
      { orderIds: [], partnerId: p.id },
      { orderIds: ids, partnerId: p.id },
      { orderIds: ['x'], partnerId: p.id },
      { orderIds: [crypto.randomUUID()] },
    ]) {
      const r = await post('/admin/orders/bulk-assign', body);
      expect(r.status).toBe(400);
    }
  });
});
