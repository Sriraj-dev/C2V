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

const get = (path: string, headers: Record<string, string> = auth.headers) => t.app.request(path, { headers });
const json = async (path: string) => (await get(path)).json() as Promise<any>;

describe('GET /admin/customers', () => {
  it('requires auth', async () => {
    expect((await get('/admin/customers', {})).status).toBe(401);
  });

  it('pages newest first with total, and hides other tenants', async () => {
    for (let i = 0; i < 3; i++) {
      await seedCustomer(t.db, 'test', { profileName: `C${i}`, createdAt: new Date(2026, 0, 1 + i) });
    }
    await seedCustomer(t.db, 'other', { profileName: 'Foreign' });
    const body = await json('/admin/customers?page=1&pageSize=2');
    expect(body.total).toBe(3);
    expect(body.items.map((c: any) => c.profileName)).toEqual(['C2', 'C1']);
    const p2 = await json('/admin/customers?page=2&pageSize=2');
    expect(p2.items.map((c: any) => c.profileName)).toEqual(['C0']);
  });

  it('searches by name, wa phone digits, address name and address phone', async () => {
    await seedCustomer(t.db, 'test', { profileName: 'Priya Sharma', waId: '919811100001' });
    await seedCustomer(t.db, 'test', {
      profileName: null,
      waId: null,
      waKey: 'bsuid-x',
      bsuid: 'bsuid-x',
      defaultAddress: { name: 'Meena Rao', line1: 'x', pincode: '560035', phone: '9876543210' } as any,
    });
    await seedCustomer(t.db, 'other', { profileName: 'Priya Other' });
    const names = async (q: string) =>
      (await json(`/admin/customers?q=${encodeURIComponent(q)}`)).items.map((c: any) => c.profileName);
    expect(await names('priya')).toEqual(['Priya Sharma']);
    expect(await names('+91 98111 00001')).toEqual(['Priya Sharma']);
    expect((await json('/admin/customers?q=meena')).items).toHaveLength(1);
    expect((await json('/admin/customers?q=9876543210')).items).toHaveLength(1);
    expect((await json('/admin/customers?q=919876543210')).items).toHaveLength(1);
    expect((await json('/admin/customers?q=%25')).items).toHaveLength(0);
    expect((await json('/admin/customers?q=zzz')).total).toBe(0);
  });

  it('phone falls back to 91 + saved address phone', async () => {
    await seedCustomer(t.db, 'test', {
      waId: null,
      waKey: 'bsuid-y',
      bsuid: 'bsuid-y',
      defaultAddress: { name: 'M', line1: 'x', pincode: '560035', phone: '9876543210' } as any,
    });
    const c = (await json('/admin/customers')).items[0];
    expect(c.phone).toBe('919876543210');
    expect(Object.keys(c).sort()).toEqual(
      ['createdAt', 'defaultAddress', 'defaultLocation', 'email', 'id', 'phone', 'profileName'],
    );
  });
});

describe('GET /admin/customers/:id', () => {
  async function seedOrder(customerId: string, code: string, createdAt: Date, tenantId = 'test') {
    await t.db.insert(orders).values({
      tenantId,
      orderCode: code,
      customerId,
      source: 'one_time',
      status: 'confirmed',
      deliveryDate: '2026-11-18',
      address: { name: 'A', line1: 'x', pincode: '560035' } as any,
      pincode: '560035',
      subtotalPaise: 100,
      deliveryFeePaise: 0,
      totalPaise: 100,
      createdAt,
    });
  }

  it('returns customer with orders newest first, capped at 20', async () => {
    const c = await seedCustomer(t.db, 'test', { waId: '919811100002' });
    for (let i = 0; i < 22; i++) await seedOrder(c.id, `NF-T${String(i).padStart(2, '0')}`, new Date(2026, 5, 1 + i));
    const body = await json(`/admin/customers/${c.id}`);
    expect(body.customer.id).toBe(c.id);
    expect(body.orders).toHaveLength(20);
    expect(body.orders[0].orderCode).toBe('NF-T21');
    expect(body.orders[1].orderCode).toBe('NF-T20');
  });

  it('404s for other tenant, unknown and malformed ids', async () => {
    const o = await seedCustomer(t.db, 'other');
    expect((await get(`/admin/customers/${o.id}`)).status).toBe(404);
    expect((await get('/admin/customers/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/admin/customers/nope')).status).toBe(404);
  });
});
