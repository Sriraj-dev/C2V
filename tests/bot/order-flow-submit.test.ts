import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOrderSummary, onOrderFlowSubmit, orderSummaryWithPayButton } from '../../src/bot/order-flow-handler.js';
import { encodeOrderFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Customer } from '../../src/customers/customer-repo.js';
import type { Db } from '../../src/db/client.js';
import { customers, orderItems, orders } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedPincode, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';
import { eq } from 'drizzle-orm';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
const tenant = testTenant();
// 2026-01-01 is a Thursday; next Wednesday is 2026-01-07.
const now = new Date('2026-01-01T06:00:00Z');

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0 });
  await seedPincode(db, 'test', '560035', 3);
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa, now: () => now });
});

type Submit = Extract<InboundMessage, { kind: 'flow_submit' }>;
function submit(customer: Customer, slotMap: Record<string, string>, response: Record<string, unknown>): Submit {
  return {
    kind: 'flow_submit',
    flowToken: encodeOrderFlowToken(customer.id, slotMap),
    response,
    phoneNumberId: 'p',
    waMessageId: 'w',
    timestamp: 0,
    from: { waId: '919811112222', bsuid: null, profileName: null },
    raw: {},
  };
}
const form = { name: 'Asha', line1: '12 MG Rd', landmark: '', pincode: '560035' };
const text = (i = 0) => (wa.sent[i]!.message as any).text.body as string;
const orderCount = async () => (await db.select().from(orders)).length;

async function setup() {
  const p6 = await seedProduct(db, 'test', { name: '6 pack', pricePaise: 9000 });
  const p30 = await seedProduct(db, 'test', { name: '30 pack', pricePaise: 42000 });
  const c = await seedCustomer(db, 'test', { waId: '919811112222' });
  return { p6, p30, c, slotMap: { '1': p6.id, '2': p30.id } };
}

describe('onOrderFlowSubmit', () => {
  it('creates a payment_pending order, saves the address, replies with the summary', async () => {
    const { c, slotMap } = await setup();
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, pincode: ' 560 035', qty_1: '2', qty_2: '1', qty_3: '0' }));
    const [o] = await db.select().from(orders);
    expect(o!.orderCode).toMatch(/^TS-[A-Z2-9]{6}$/);
    expect(o!.totalPaise).toBe(60000);
    expect(o!.status).toBe('payment_pending');
    expect(o!.deliveryDate).toBe('2026-01-07');
    expect(await db.select().from(orderItems)).toHaveLength(2);
    const [saved] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(saved!.defaultAddress).toEqual({ name: 'Asha', line1: '12 MG Rd', pincode: '560035' });
    expect(text()).toContain(o!.orderCode);
    expect(text()).toContain('6 pack × 2 — ₹180');
    expect(text()).toContain('₹600');
    expect(text()).toContain('Wed, 7 Jan');
  });

  it('rejects over-length name/address/landmark', async () => {
    const { c, slotMap } = await setup();
    for (const over of [{ name: 'a'.repeat(81) }, { line1: 'a'.repeat(301) }, { landmark: 'a'.repeat(101) }]) {
      await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, ...over, qty_1: '1' }));
    }
    expect(wa.sent.map((_, i) => text(i))).toEqual(Array(3).fill(tenant.copy.invalidAddress()));
    expect(await orderCount()).toBe(0);
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, name: 'a'.repeat(80), line1: 'a'.repeat(300), landmark: 'a'.repeat(100), qty_1: '1' }));
    expect(await orderCount()).toBe(1);
  });

  it.each([
    ['Tue 23:30 IST -> next day (Wed)', '2026-01-06T18:00:00Z', '2026-01-07'],
    ['Wed 00:30 IST -> next week Wed', '2026-01-06T19:00:00Z', '2026-01-14'],
  ])('IST boundary: %s', async (_n, iso, expected) => {
    const { c, slotMap } = await setup();
    const d = { ...deps, now: () => new Date(iso) };
    await onOrderFlowSubmit(d, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }));
    expect((await db.select().from(orders))[0]!.deliveryDate).toBe(expected);
  });

  it('all-zero quantities -> noItems, no order', async () => {
    const { c, slotMap } = await setup();
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '0', qty_2: '' }));
    expect(text()).toBe(tenant.copy.noItems());
    expect(await orderCount()).toBe(0);
  });

  it('invalid pincode and empty address replies', async () => {
    const { c, slotMap } = await setup();
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, pincode: '56003', qty_1: '1' }));
    expect(text(0)).toBe(tenant.copy.invalidPincode('56003'));
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, name: '  ', qty_1: '1' }));
    expect(text(1)).toBe(tenant.copy.invalidAddress());
    expect(await orderCount()).toBe(0);
  });

  it('unserviceable pincode', async () => {
    const { c, slotMap } = await setup();
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, pincode: '110001', qty_1: '1' }));
    expect(text()).toBe(tenant.copy.notServiceable('110001'));
    expect(await orderCount()).toBe(0);
  });

  it('minimum order: below -> belowMinimum, exactly at min -> order', async () => {
    const { p6, c, slotMap } = await setup();
    await db.execute((await import('drizzle-orm')).sql`update tenants set min_order_paise = 10000`);
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }));
    expect(text()).toBe(tenant.copy.belowMinimum('₹100'));
    expect(await orderCount()).toBe(0);
    await db.execute((await import('drizzle-orm')).sql`update tenants set min_order_paise = 18000`);
    await onOrderFlowSubmit(deps, tenant, c, submit(c, { '1': p6.id }, { ...form, qty_1: '2' }));
    expect(await orderCount()).toBe(1);
  });

  it('ignores deactivated products and tampered prices', async () => {
    const { p30, c, slotMap } = await setup();
    await db.execute((await import('drizzle-orm')).sql`update products set active = false where id = ${p30.id}`);
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1', qty_2: '3', price_1: '1', unit_price_paise: 1 }));
    const [o] = await db.select().from(orders);
    expect(o!.totalPaise).toBe(9000);
    expect(await db.select().from(orderItems)).toHaveLength(1);
  });

  it('only deactivated product selected -> noItems', async () => {
    const { p6, c, slotMap } = await setup();
    await db.execute((await import('drizzle-orm')).sql`update products set active = false where id = ${p6.id}`);
    await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }));
    expect(text()).toBe(tenant.copy.noItems());
  });

  it('token for another customer or malformed -> menu, no order, no PII in warn', async () => {
    const { c, slotMap } = await setup();
    const other = await seedCustomer(db, 'test');
    const warn = vi.fn();
    const d = { ...deps, log: { ...deps.log, warn } as any };
    await onOrderFlowSubmit(d, tenant, c, submit(other, slotMap, { ...form, qty_1: '1' }));
    await onOrderFlowSubmit(d, tenant, c, { ...submit(c, slotMap, form), flowToken: 'order:garbage' });
    expect(wa.sent).toHaveLength(2);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
    expect(await orderCount()).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Asha');
  });
});

describe('summary builders', () => {
  it('orderSummaryWithPayButton builds a cta_url within limits', () => {
    const m = orderSummaryWithPayButton('body text', 'https://pay.example/x') as any;
    expect(m.interactive.type).toBe('cta_url');
    expect(m.interactive.action.parameters.display_text).toBe('Pay now');
    expect(m.interactive.action.parameters.display_text.length).toBeLessThanOrEqual(20);
    expect(m.interactive.body.text.length).toBeLessThanOrEqual(1024);
    expect(m.interactive.action.parameters.url).toBe('https://pay.example/x');
  });
  it('buildOrderSummary is pure and formats lines', () => {
    const order = {
      orderCode: 'TS-ABC234',
      deliveryDate: '2026-01-07',
      totalPaise: 18000,
      items: [{ productId: 'a', name: 'Six', quantity: 2, lineTotalPaise: 18000 }],
    } as any;
    const s = buildOrderSummary(tenant, order, []);
    expect(s).toContain('TS-ABC234');
    expect(s).toContain('Six × 2 — ₹180');
    expect(s).toContain('Wed, 7 Jan');
  });
});
