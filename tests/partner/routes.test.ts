import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { deliveryPartners, orderItems, orders } from '../../src/db/schema.js';
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

async function partner(tenantId = 'test', name = 'Ravi') {
  const r = await t.app.request('/admin/partners', {
    method: 'POST',
    headers: { ...(tenantId === 'test' ? auth.headers : (await t.login(tenantId)).headers), 'content-type': 'application/json' },
    body: JSON.stringify({ name, phone: '9812345678' }),
  });
  return ((await r.json()) as any).partner as { id: string; accessToken: string };
}

async function order(partnerId: string | null, status: any = 'assigned', tenantId = 'test', date = '2026-11-18') {
  n++;
  const c = await seedCustomer(t.db, tenantId, { waId: `9198222${String(10000 + n)}` } as any);
  const [o] = await t.db
    .insert(orders)
    .values({
      tenantId, orderCode: `NF-${n}ZZZZ`, customerId: c.id, source: 'one_time', status, deliveryDate: date,
      address: { name: 'Asha', line1: 'x', pincode: '560035' } as any,
      location: { lat: 12.9, lng: 77.6 }, pincode: '560035',
      subtotalPaise: 60000, deliveryFeePaise: 0, totalPaise: 60000, assignedPartnerId: partnerId,
    })
    .returning();
  const p = await seedProduct(t.db, tenantId);
  await t.db.insert(orderItems).values({
    orderId: o!.id, productId: p.id, name: p.name, unitPricePaise: 30000, quantity: 2, lineTotalPaise: 60000,
  });
  return o!;
}

const get = (token: string, path = '/orders') => t.app.request(`/partner/${token}${path}`);
const post = (token: string, path: string) => t.app.request(`/partner/${token}${path}`, { method: 'POST' });

describe('partner API', () => {
  it('lists only own open orders sorted by date, no prices, with headers', async () => {
    const p = await partner();
    const other = await partner('test', 'Sita');
    const o2 = await order(p.id, 'out_for_delivery', 'test', '2026-11-20');
    const o1 = await order(p.id, 'assigned', 'test', '2026-11-18');
    await order(p.id, 'delivered');
    await order(other.id);
    const op = await partner('other');
    await order(op.id, 'assigned', 'other');
    const r = await get(p.accessToken);
    expect(r.status).toBe(200);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = (await r.json()) as any;
    expect(j.partner).toEqual({ name: 'Ravi' });
    expect(j.items.map((i: any) => i.id)).toEqual([o1.id, o2.id]);
    expect(JSON.stringify(j)).not.toContain('Paise');
    expect(j.items[0]).toMatchObject({
      customerName: 'Asha', mapUrl: 'https://maps.google.com/?q=12.9,77.6', status: 'assigned',
    });
    expect(j.items[0].customerPhone).toMatch(/^9198222/);
    expect(Object.keys(j.items[0].items[0]).sort()).toEqual(['name', 'quantity']);
  });

  it('out-for-delivery then delivered sends the template', async () => {
    const p = await partner();
    const o = await order(p.id);
    const r1 = await post(p.accessToken, `/orders/${o.id}/out-for-delivery`);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).order.status).toBe('out_for_delivery');
    const before = t.wa.sent.length;
    const r2 = await post(p.accessToken, `/orders/${o.id}/delivered`);
    expect(r2.status).toBe(200);
    const j = (await r2.json()) as any;
    expect(j.order.status).toBe('delivered');
    expect(j.notified).toBe(true);
    expect(t.wa.sent.length).toBe(before + 1);
    expect(JSON.stringify(j)).not.toContain('Paise');
    // Delivered is no longer open: a repeat is 404.
    expect((await post(p.accessToken, `/orders/${o.id}/delivered`)).status).toBe(404);
  });

  it('invalid transition maps to 409 with headers', async () => {
    const p = await partner();
    const o = await order(p.id, 'out_for_delivery');
    const r = await post(p.accessToken, `/orders/${o.id}/out-for-delivery`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('invalid_transition');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('404 for another partner order, other tenant order, reassigned order, bad ids', async () => {
    const p = await partner();
    const q = await partner('test', 'Sita');
    const theirs = await order(q.id);
    expect((await post(p.accessToken, `/orders/${theirs.id}/delivered`)).status).toBe(404);
    const op = await partner('other');
    const foreign = await order(op.id, 'assigned', 'other');
    expect((await post(p.accessToken, `/orders/${foreign.id}/out-for-delivery`)).status).toBe(404);
    const mine = await order(p.id);
    await t.db.update(orders).set({ assignedPartnerId: q.id }).where(eq(orders.id, mine.id));
    expect((await post(p.accessToken, `/orders/${mine.id}/out-for-delivery`)).status).toBe(404);
    expect((await post(p.accessToken, '/orders/not-a-uuid/delivered')).status).toBe(404);
    expect(((await (await get(p.accessToken)).json()) as any).items).toHaveLength(0);
  });

  it('unknown, malformed and inactive tokens give 404 JSON with headers', async () => {
    const p = await partner();
    for (const tok of ['x'.repeat(43), 'short', 'a'.repeat(44), `${'a'.repeat(42)}!`]) {
      const r = await get(tok);
      expect(r.status).toBe(404);
      expect(((await r.json()) as any).error.code).toBe('not_found');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const r = await t.app.request('/partner/nothing/here/at/all');
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
    await t.db.update(deliveryPartners).set({ active: false }).where(eq(deliveryPartners.id, p.id));
    expect((await get(p.accessToken)).status).toBe(404);
  });

  it('an unexpected 500 logs the path without the token', async () => {
    const p = await partner();
    const o = await order(p.id);
    const lines: string[] = [];
    const log = pino({ level: 'error' }, { write: (m: string) => void lines.push(m) });
    const app = buildApp({ ...t.deps, log });
    const spy = vi.spyOn(t.db, 'update').mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await app.request(`/partner/${p.accessToken}/orders/${o.id}/out-for-delivery`, { method: 'POST' });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).toContain('/partner/[redacted]/orders/');
    expect(lines.join('')).not.toContain(p.accessToken);
  });
});
