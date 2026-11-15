import { beforeEach, describe, expect, it } from 'vitest';
import { orders } from '../../src/db/schema.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';
import { seedCustomer } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: AdminTest;
let auth: AdminLogin;

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth.headers) =>
  t.app.request(path, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const create = async (body: unknown = { name: 'Ravi', phone: '9812345678' }, headers = auth.headers) =>
  call('POST', '/admin/partners', body, headers);

describe('admin partners', () => {
  it('creates with a 43-char token and normalized phone', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    const { partner } = (await r.json()) as any;
    expect(partner.accessToken).toHaveLength(43);
    expect(partner.phone).toBe('919812345678');
    expect(partner.active).toBe(true);
    expect(partner.openOrderCount).toBe(0);
    expect(partner.accessTokenCreatedAt).toBe(t.deps.now().toISOString());
  });

  it('rejects bad input and requires auth', async () => {
    expect((await create({ name: 'R', phone: '12345' })).status).toBe(400);
    expect((await create({ name: '', phone: '9812345678' })).status).toBe(400);
    expect((await create({ name: 'R', phone: '9812345678', x: 1 })).status).toBe(400);
    expect((await call('GET', '/admin/partners', undefined, {})).status).toBe(401);
  });

  it('lists with openOrderCount, tenant scoped', async () => {
    const { partner } = (await (await create()).json()) as any;
    await create({ name: 'Other', phone: '9812345679' }, (await t.login('other')).headers);
    const c = await seedCustomer(t.db, 'test');
    const mk = (status: any, code: string) =>
      t.db.insert(orders).values({
        tenantId: 'test', orderCode: code, customerId: c.id, source: 'one_time', status,
        deliveryDate: '2026-11-18', address: { name: 'A', line1: 'x', pincode: '560035' } as any,
        pincode: '560035', subtotalPaise: 1, deliveryFeePaise: 0, totalPaise: 1, assignedPartnerId: partner.id,
      });
    await mk('assigned', 'A1');
    await mk('out_for_delivery', 'A2');
    await mk('delivered', 'A3');
    const j = (await (await call('GET', '/admin/partners')).json()) as any;
    expect(j.items).toHaveLength(1);
    expect(j.items[0].openOrderCount).toBe(2);
  });

  it('patches; empty body 400; other tenant 404', async () => {
    const { partner } = (await (await create()).json()) as any;
    const r = await call('PATCH', `/admin/partners/${partner.id}`, { name: 'Ravi K', phone: '+919800000001' });
    expect(((await r.json()) as any).partner).toMatchObject({ name: 'Ravi K', phone: '919800000001' });
    expect((await call('PATCH', `/admin/partners/${partner.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/admin/partners/${partner.id}`, { phone: 'bad' })).status).toBe(400);
    const other = await t.login('other');
    expect((await call('PATCH', `/admin/partners/${partner.id}`, { active: false }, other.headers)).status).toBe(404);
    expect((await call('POST', `/admin/partners/${partner.id}/reset-link`, undefined, other.headers)).status).toBe(404);
    expect((await call('PATCH', '/admin/partners/nope', { active: false })).status).toBe(404);
  });

  it('reset-link replaces the token; the old link stops working', async () => {
    const { partner } = (await (await create()).json()) as any;
    expect((await t.app.request(`/partner/${partner.accessToken}/orders`)).status).toBe(200);
    const r = await call('POST', `/admin/partners/${partner.id}/reset-link`);
    const fresh = ((await r.json()) as any).partner;
    expect(fresh.accessToken).toHaveLength(43);
    expect(fresh.accessToken).not.toBe(partner.accessToken);
    expect((await t.app.request(`/partner/${partner.accessToken}/orders`)).status).toBe(404);
    expect((await t.app.request(`/partner/${fresh.accessToken}/orders`)).status).toBe(200);
  });

  it('deactivating disables the link', async () => {
    const { partner } = (await (await create()).json()) as any;
    await call('PATCH', `/admin/partners/${partner.id}`, { active: false });
    expect((await t.app.request(`/partner/${partner.accessToken}/orders`)).status).toBe(404);
  });
});
