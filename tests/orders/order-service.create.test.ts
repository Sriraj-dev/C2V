import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { orders } from '../../src/db/schema.js';
import { createOrder, isOrderCodeCollision, parseOrderSubmission } from '../../src/orders/order-service.js';
import { findOrderByCode, listRecentOrders } from '../../src/orders/order-repo.js';
import { createTestDb, seedCustomer, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 500 });
});

const address = { name: 'Asha', line1: '12 MG Rd', pincode: '560034' };
const base = { address, location: null, status: 'payment_pending' as const, source: 'one_time' as const, deliveryDate: '2026-01-07' };

describe('parseOrderSubmission', () => {
  it('only counts slotMap keys, clamps qty and sums duplicate products', async () => {
    const p = await seedProduct(db, 'test');
    const q = await seedProduct(db, 'test');
    const r = parseOrderSubmission(
      { qty_1: '2', qty_2: '11', qty_3: '5', qty_4: '1.5', qty_5: -1, name: ' A ', line1: ' L ', landmark: ' ', pincode: '560 034' },
      { '1': p.id, '2': q.id, '3': p.id },
      [p, q],
    );
    expect('lines' in r && r.lines.map((l) => [l.product.id, l.quantity])).toEqual([[p.id, 7]]);
    expect('address' in r && r.address).toEqual({ name: 'A', line1: 'L', pincode: '560034' });
  });
  it('flags empty name/address', async () => {
    const p = await seedProduct(db, 'test');
    expect(parseOrderSubmission({ qty_1: '1', name: ' ', line1: 'x', pincode: '560034' }, { '1': p.id }, [p])).toEqual({ error: 'invalid_address' });
  });
});

describe('createOrder', () => {
  it('snapshots prices, totals include the fee, items in the same order', async () => {
    const p = await seedProduct(db, 'test', { name: 'Six', pricePaise: 9000 });
    const c = await seedCustomer(db, 'test');
    const o = await createOrder({ db }, testTenant(), c, { ...base, lines: [{ product: p, quantity: 2 }] });
    expect(o.orderCode).toMatch(/^TS-[A-Z2-9]{6}$/);
    expect([o.subtotalPaise, o.deliveryFeePaise, o.totalPaise]).toEqual([18000, 500, 18500]);
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ name: 'Six', unitPricePaise: 9000, quantity: 2, lineTotalPaise: 18000 });
    expect((await findOrderByCode(db, 'test', o.orderCode))?.id).toBe(o.id);
    expect(await listRecentOrders(db, 'test', c.id, 5)).toHaveLength(1);
  });
  it('unitPrices override DB prices', async () => {
    const p = await seedProduct(db, 'test', { pricePaise: 9000 });
    const c = await seedCustomer(db, 'test');
    const o = await createOrder({ db }, testTenant(), c, { ...base, lines: [{ product: p, quantity: 1 }], unitPrices: { [p.id]: 8000 } });
    expect(o.subtotalPaise).toBe(8000);
  });
  it('retries on an order-code collision', async () => {
    const p = await seedProduct(db, 'test');
    const c = await seedCustomer(db, 'test');
    const t = testTenant();
    const fixed = (n: number) => new Uint8Array(n).fill(1);
    const first = await createOrder({ db }, t, c, { ...base, lines: [{ product: p, quantity: 1 }] }, { random: fixed });
    let calls = 0;
    const random = (n: number) => (++calls <= 2 ? fixed(n) : new Uint8Array(n).fill(5));
    const second = await createOrder({ db }, t, c, { ...base, lines: [{ product: p, quantity: 1 }] }, { random });
    expect(second.orderCode).not.toBe(first.orderCode);
    expect(calls).toBe(3);
  });
  it('gives up after 3 collisions and leaves no partial order', async () => {
    const p = await seedProduct(db, 'test');
    const c = await seedCustomer(db, 'test');
    const fixed = (n: number) => new Uint8Array(n).fill(1);
    await createOrder({ db }, testTenant(), c, { ...base, lines: [{ product: p, quantity: 1 }] }, { random: fixed });
    await expect(createOrder({ db }, testTenant(), c, { ...base, lines: [{ product: p, quantity: 1 }] }, { random: fixed })).rejects.toBeTruthy();
    expect(await db.select().from(orders).where(eq(orders.tenantId, 'test'))).toHaveLength(1);
  });
  it('isOrderCodeCollision only matches the order_code constraint', () => {
    const c = 'orders_tenant_order_code_uq';
    expect(isOrderCodeCollision({ cause: { code: '23505', constraint: c } })).toBe(true);
    expect(isOrderCodeCollision({ cause: { code: '23505', constraint_name: c } })).toBe(true);
    expect(isOrderCodeCollision({ code: '23505', message: `duplicate key value violates unique constraint "${c}"` })).toBe(true);
    expect(isOrderCodeCollision({ cause: { code: '23505', constraint_name: 'other_uq' } })).toBe(false);
    expect(isOrderCodeCollision({ code: '23505', constraint: 'other_uq', message: c })).toBe(false);
    expect(isOrderCodeCollision(new Error('x'))).toBe(false);
  });
  it('keeps line order by position', async () => {
    const ps = [];
    for (const n of ['Zed', 'Alpha', 'Mid']) ps.push(await seedProduct(db, 'test', { name: n }));
    const c = await seedCustomer(db, 'test');
    const o = await createOrder({ db }, testTenant(), c, { ...base, lines: ps.map((product) => ({ product, quantity: 1 })) });
    expect(o.items.map((i) => i.name)).toEqual(['Zed', 'Alpha', 'Mid']);
    expect((await findOrderByCode(db, 'test', o.orderCode))!.items.map((i) => i.name)).toEqual(['Zed', 'Alpha', 'Mid']);
  });
});
