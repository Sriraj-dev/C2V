import { beforeEach, describe, expect, it } from 'vitest';
import { findActivePincode } from '../../src/catalog/catalog-repo.js';
import { pincodes, products } from '../../src/db/schema.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: AdminTest;
let auth: AdminLogin;

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth.headers) =>
  t.app.request(`/admin${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const mk = async (n: number, tenantId = 'test', active = true) => {
  const rows = await t.db
    .insert(products)
    .values(Array.from({ length: n }, (_, i) => ({ tenantId, sku: `S${i}`, name: `P${i}`, pricePaise: 100, active, sortOrder: i })))
    .returning();
  return rows;
};

describe('/admin/products', () => {
  it('requires auth', async () => {
    expect((await send('GET', '/products', undefined, {})).status).toBe(401);
    expect((await send('POST', '/products', {}, {})).status).toBe(401);
  });

  it('creates (sku uppercased/trimmed, default sortOrder = max+1, active default) and lists sorted', async () => {
    const a = await send('POST', '/products', { sku: ' tray-30 ', name: ' Tray of 30 ', pricePaise: 18000 });
    expect(a.status).toBe(201);
    const { product } = (await a.json()) as any;
    expect(product).toMatchObject({ sku: 'TRAY-30', name: 'Tray of 30', pricePaise: 18000, active: true, sortOrder: 1 });
    expect(Object.keys(product).sort()).toEqual(['active', 'createdAt', 'id', 'name', 'pricePaise', 'sku', 'sortOrder']);
    const b = (await (await send('POST', '/products', { sku: 'B', name: 'B', pricePaise: 1, sortOrder: 0 })).json()) as any;
    const c = (await (await send('POST', '/products', { sku: 'C', name: 'C', pricePaise: 1 })).json()) as any;
    expect(c.product.sortOrder).toBe(2);
    const list = (await (await send('GET', '/products')).json()) as any;
    expect(list.items.map((p: any) => p.sku)).toEqual(['B', 'TRAY-30', 'C']);
    expect(b.product.sortOrder).toBe(0);
  });

  it('validates bodies', async () => {
    for (const body of [
      { sku: 'bad sku', name: 'x', pricePaise: 1 },
      { sku: 'straße', name: 'x', pricePaise: 1 },
      { sku: '', name: 'x', pricePaise: 1 },
      { sku: 'A', name: '  ', pricePaise: 1 },
      { sku: 'A', name: 'x'.repeat(61), pricePaise: 1 },
      { sku: 'A', name: 'x', pricePaise: 0 },
      { sku: 'A', name: 'x', pricePaise: 10_000_001 },
      { sku: 'A', name: 'x', pricePaise: 1.5 },
      { sku: 'A', name: 'x', pricePaise: 1, tenantId: 'other' },
    ]) {
      const res = await send('POST', '/products', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('validation_error');
    }
  });

  it('rejects a duplicate SKU with 409 conflict; same SKU under another tenant is fine', async () => {
    await mk(1, 'other');
    const ok = await send('POST', '/products', { sku: 's0', name: 'x', pricePaise: 1 });
    expect(ok.status).toBe(201);
    const dup = await send('POST', '/products', { sku: 'S0', name: 'y', pricePaise: 1 });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe('conflict');
  });

  it('PATCH is partial, persists, and rejects empty/unknown bodies and duplicate sku', async () => {
    const [p, q] = await mk(2);
    const res = await send('PATCH', `/products/${p!.id}`, { name: ' New ', pricePaise: 500 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).product).toMatchObject({ id: p!.id, sku: 'S0', name: 'New', pricePaise: 500 });
    const renamed = await send('PATCH', `/products/${p!.id}`, { sku: ' new-sku ' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).product.sku).toBe('NEW-SKU');
    for (const bad of [{ pricePaise: 0 }, { pricePaise: 10_000_001 }, { sku: 'straße' }]) {
      expect((await send('PATCH', `/products/${p!.id}`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await send('PATCH', `/products/${p!.id}`, {})).status).toBe(400);
    expect((await send('PATCH', `/products/${p!.id}`, { bogus: 1 })).status).toBe(400);
    const dup = await send('PATCH', `/products/${p!.id}`, { sku: q!.sku });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe('conflict');
  });

  it('enforces the 8-active limit on create and on activation, not on other edits', async () => {
    const rows = await mk(8);
    const ninth = await send('POST', '/products', { sku: 'NINE', name: 'x', pricePaise: 1 });
    expect(ninth.status).toBe(409);
    expect(((await ninth.json()) as any).error.code).toBe('too_many_active_products');
    // inactive 9th is allowed, activating it is not
    const inactive = await send('POST', '/products', { sku: 'NINE', name: 'x', pricePaise: 1, active: false });
    expect(inactive.status).toBe(201);
    const id = ((await inactive.json()) as any).product.id;
    const act = await send('PATCH', `/products/${id}`, { active: true });
    expect(act.status).toBe(409);
    expect(((await act.json()) as any).error.code).toBe('too_many_active_products');
    // editing an already-active one is fine, even sending active:true
    expect((await send('PATCH', `/products/${rows[0]!.id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await send('PATCH', `/products/${rows[0]!.id}`, { active: true })).status).toBe(200);
    // deactivating frees a slot
    expect((await send('PATCH', `/products/${rows[1]!.id}`, { active: false })).status).toBe(200);
    expect((await send('PATCH', `/products/${id}`, { active: true })).status).toBe(200);
  });

  it('other tenant products count nothing and are 404', async () => {
    await mk(8, 'other');
    expect((await send('POST', '/products', { sku: 'A', name: 'x', pricePaise: 1 })).status).toBe(201);
    const [theirs] = await t.db
      .insert(products)
      .values({ tenantId: 'other', sku: 'EXTRA', name: 'x', pricePaise: 1 })
      .returning();
    expect((await send('PATCH', `/products/${theirs!.id}`, { name: 'x' })).status).toBe(404);
    expect((await send('PATCH', '/products/not-a-uuid', { name: 'x' })).status).toBe(404);
    const list = (await (await send('GET', '/products')).json()) as any;
    expect(list.items).toHaveLength(1);
  });

  it('concurrent creates cannot exceed 8 active', async () => {
    await mk(7);
    const rs = await Promise.all(
      [1, 2, 3].map((i) => send('POST', '/products', { sku: `N${i}`, name: 'x', pricePaise: 1 })),
    );
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });
});

describe('/admin/pincodes', () => {
  it('requires auth', async () => {
    expect((await send('GET', '/pincodes', undefined, {})).status).toBe(401);
  });

  it('creates, normalises, lists sorted, and rejects duplicates', async () => {
    const res = await send('POST', '/pincodes', { pincode: ' 500 081 ', deliveryWeekday: 3, note: '  Madhapur  ' });
    expect(res.status).toBe(201);
    const { pincode } = (await res.json()) as any;
    expect(pincode).toMatchObject({ pincode: '500081', deliveryWeekday: 3, note: 'Madhapur', active: true });
    expect(Object.keys(pincode).sort()).toEqual(['active', 'createdAt', 'deliveryWeekday', 'id', 'note', 'pincode']);
    await send('POST', '/pincodes', { pincode: '500001', deliveryWeekday: 0, note: '   ' });
    const list = (await (await send('GET', '/pincodes')).json()) as any;
    expect(list.items.map((p: any) => p.pincode)).toEqual(['500001', '500081']);
    expect(list.items[0].note).toBeNull();
    const dup = await send('POST', '/pincodes', { pincode: '500081', deliveryWeekday: 1 });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe('conflict');
  });

  it('validates bodies', async () => {
    for (const body of [
      { pincode: '500081', deliveryWeekday: 7 },
      { pincode: '500081', deliveryWeekday: -1 },
      { pincode: '500081', deliveryWeekday: 1.5 },
      { pincode: '12345', deliveryWeekday: 1 },
      { pincode: '000000', deliveryWeekday: 1 },
      { pincode: '500081', deliveryWeekday: 1, note: 'x'.repeat(121) },
      { deliveryWeekday: 1 },
    ]) {
      const res = await send('POST', '/pincodes', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('validation_error');
    }
  });

  it('PATCH persists and findActivePincode reflects active:false; pincode key is rejected', async () => {
    const created = (await (await send('POST', '/pincodes', { pincode: '500081', deliveryWeekday: 3 })).json()) as any;
    const id = created.pincode.id;
    expect(await findActivePincode(t.db, 'test', '500081')).not.toBeNull();
    const res = await send('PATCH', `/pincodes/${id}`, { deliveryWeekday: 5, note: 'x', active: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).pincode).toMatchObject({ deliveryWeekday: 5, note: 'x', active: false });
    expect(await findActivePincode(t.db, 'test', '500081')).toBeNull();
    const [row] = await t.db.select().from(pincodes);
    expect(row).toMatchObject({ deliveryWeekday: 5, active: false });
    expect((await send('PATCH', `/pincodes/${id}`, { note: null })).status).toBe(200);
    expect((await send('PATCH', `/pincodes/${id}`, { pincode: '500082' })).status).toBe(400);
    expect((await send('PATCH', `/pincodes/${id}`, {})).status).toBe(400);
    expect((await send('PATCH', `/pincodes/${id}`, { deliveryWeekday: 9 })).status).toBe(400);
  });

  it('other tenant pincodes are 404 and invisible', async () => {
    const [theirs] = await t.db.insert(pincodes).values({ tenantId: 'other', pincode: '500081', deliveryWeekday: 1 }).returning();
    expect((await send('PATCH', `/pincodes/${theirs!.id}`, { active: false })).status).toBe(404);
    expect((await send('PATCH', '/pincodes/nope', { active: false })).status).toBe(404);
    expect((await send('POST', '/pincodes', { pincode: '500081', deliveryWeekday: 1 })).status).toBe(201);
    expect((((await (await send('GET', '/pincodes')).json()) as any).items as any[]).length).toBe(1);
  });
});
