import { beforeEach, describe, expect, it } from 'vitest';
import { deliveryPartners, orderItems, orders, payments } from '../../src/db/schema.js';
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

const get = (path: string, headers: Record<string, string> = auth.headers) => t.app.request(path, { headers });

describe('GET /admin/orders/active', () => {
  it('returns only active statuses in delivery-date order with joined data', async () => {
    const [partner] = await t.db
      .insert(deliveryPartners)
      .values({ tenantId: 'test', name: 'Ravi', phone: '919800000001' })
      .returning();
    const late = await seedOrder('confirmed', { deliveryDate: '2026-11-20' });
    const early = await seedOrder('assigned', {
      deliveryDate: '2026-11-16',
      partnerId: partner!.id,
      location: { lat: 12.9, lng: 77.6 },
    });
    const ofd = await seedOrder('out_for_delivery', { deliveryDate: '2026-11-18' });
    await seedOrder('delivered');
    await seedOrder('payment_pending', { payment: 'created' });
    await seedOrder('confirmed', { tenantId: 'other' });
    const res = await get('/admin/orders/active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items.map((i: any) => i.id)).toEqual([early.id, ofd.id, late.id]);
    const first = body.items[0];
    expect(first.partner).toEqual({ id: partner!.id, name: 'Ravi', phone: '919800000001' });
    expect(first.paymentStatus).toBe('paid');
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ quantity: 2, unitPricePaise: 30000, lineTotalPaise: 60000 });
    expect(first.customer.phone).toMatch(/^9198111/);
    expect(first.mapUrl).toBe('https://maps.google.com/?q=12.9,77.6');
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items[1].partner).toBeNull();
    expect(body.items[1].mapUrl).toBeNull();
  });

  it('requires a session', async () => {
    expect((await get('/admin/orders/active', {})).status).toBe(401);
  });
});

describe('GET /admin/orders', () => {
  it('pages newest first with total', async () => {
    const a = await seedOrder('delivered', { createdAt: new Date('2026-11-01T00:00:00Z') });
    const b = await seedOrder('cancelled', { createdAt: new Date('2026-11-02T00:00:00Z') });
    await seedOrder('delivered', { tenantId: 'other' });
    const body = (await (await get('/admin/orders')).json()) as any;
    expect(body).toMatchObject({ page: 1, pageSize: 25, total: 2 });
    expect(body.items.map((i: any) => i.id)).toEqual([b.id, a.id]);
    const p2 = (await (await get('/admin/orders?pageSize=1&page=2')).json()) as any;
    expect(p2.items.map((i: any) => i.id)).toEqual([a.id]);
    expect(p2.total).toBe(2);
  });

  it('filters by status, inclusive date range, pincode, partner', async () => {
    const [partner] = await t.db
      .insert(deliveryPartners)
      .values({ tenantId: 'test', name: 'Ravi', phone: '919800000001' })
      .returning();
    const d = await seedOrder('delivered', { deliveryDate: '2026-11-10' });
    const c = await seedOrder('cancelled', { deliveryDate: '2026-11-12', pincode: '560001', partnerId: partner!.id });
    await seedOrder('confirmed', { deliveryDate: '2026-11-14' });
    const ids = async (qs: string) => ((await (await get(`/admin/orders?${qs}`)).json()) as any).items.map((i: any) => i.id).sort();
    expect(await ids('status=delivered,cancelled')).toEqual([d.id, c.id].sort());
    expect(await ids('deliveryFrom=2026-11-10&deliveryTo=2026-11-12')).toEqual([d.id, c.id].sort());
    expect(await ids('deliveryFrom=2026-11-11&deliveryTo=2026-11-12')).toEqual([c.id]);
    expect(await ids('pincode=560001')).toEqual([c.id]);
    expect(await ids(`partnerId=${partner!.id}`)).toEqual([c.id]);
  });

  it('searches by order code and phone, escaping wildcards', async () => {
    const a = await seedOrder('delivered', { code: 'NF-7K3QX9', waId: '919811100001' });
    await seedOrder('delivered', { code: 'NF-ZZZZZZ', waId: '919822200002' });
    const ids = async (q: string) => ((await (await get(`/admin/orders?q=${encodeURIComponent(q)}`)).json()) as any).items.map((i: any) => i.id);
    expect(await ids('7K3')).toEqual([a.id]);
    expect(await ids('7k3')).toEqual([a.id]);
    expect(await ids('98111')).toEqual([a.id]);
    expect(await ids('%')).toEqual([]);
    expect(await ids('_')).toEqual([]);
  });

  it('rejects bad query values', async () => {
    for (const qs of ['pageSize=101', 'status=bogus', 'deliveryFrom=11-01-2026', 'pincode=12', 'partnerId=nope']) {
      const res = await get(`/admin/orders?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('validation_error');
    }
  });
});

describe('GET /admin/orders/:id', () => {
  it('returns own order, 404 for other tenant or non-uuid', async () => {
    const mine = await seedOrder('confirmed');
    const theirs = await seedOrder('confirmed', { tenantId: 'other' });
    const ok = await get(`/admin/orders/${mine.id}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).order.id).toBe(mine.id);
    for (const id of [theirs.id, 'not-a-uuid']) {
      const res = await get(`/admin/orders/${id}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe('not_found');
    }
  });

  it('derives phone from the address for BSUID-only customers', async () => {
    const o = await seedOrder('confirmed', { waId: null, phone: '9876543210' });
    const body = (await (await get(`/admin/orders/${o.id}`)).json()) as any;
    expect(body.order.customer.phone).toBe('919876543210');
  });
});

describe('GET /admin/refunds/needed', () => {
  it('lists paid cancelled/expired orders with a reason', async () => {
    const c = await seedOrder('cancelled', { payment: 'paid' });
    const e = await seedOrder('expired', { payment: 'paid' });
    await seedOrder('cancelled', { payment: 'refunded' });
    await seedOrder('cancelled', { payment: 'created' });
    await seedOrder('delivered', { payment: 'paid' });
    await seedOrder('cancelled', { payment: 'paid', tenantId: 'other' });
    const res = await get('/admin/refunds/needed');
    expect(res.status).toBe(200);
    const items = ((await res.json()) as any).items;
    expect(Object.fromEntries(items.map((i: any) => [i.id, i.refundReason]))).toEqual({
      [c.id]: 'cancelled_after_payment',
      [e.id]: 'paid_after_expiry',
    });
    expect(items[0].items).toHaveLength(1);
  });

  it('requires a session', async () => {
    expect((await get('/admin/refunds/needed', {})).status).toBe(401);
  });
});
