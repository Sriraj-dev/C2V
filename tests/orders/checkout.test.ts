import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onOrderFlowSubmit } from '../../src/bot/order-flow-handler.js';
import { encodeOrderFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Customer } from '../../src/customers/customer-repo.js';
import type { Db } from '../../src/db/client.js';
import { customers, orders, payments } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { confirmPaidOrder } from '../../src/orders/checkout.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedPincode, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
const tenant = testTenant();
// 2026-11-12 is a Thursday; next Wednesday is 2026-11-18.
const now = new Date('2026-11-12T06:00:00Z');

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0 });
  await seedPincode(db, 'test', '560035', 3);
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => now });
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
    from: { waId: customer.waId, bsuid: customer.bsuid, profileName: null },
    raw: {},
  } as Submit;
}
const form = { name: 'Asha', line1: '12 MG Rd', landmark: '', pincode: '560035' };
const msgs = () => wa.sent.map((s) => s.message as any);

async function setup(customerOverrides: Partial<typeof customers.$inferInsert> = {}) {
  const p6 = await seedProduct(db, 'test', { name: '6 pack', pricePaise: 9000 });
  const p30 = await seedProduct(db, 'test', { name: '30 pack', pricePaise: 42000 });
  const c = await seedCustomer(db, 'test', { waId: '919811112222', ...customerOverrides });
  return { c, slotMap: { '1': p6.id, '2': p30.id } };
}

/** Places an order (2x6 pack + 1x30 pack = Rs 600) and returns it with its link id. */
async function placeOrder(c: Customer, slotMap: Record<string, string>) {
  await onOrderFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '2', qty_2: '1' }));
  const [o] = await db.select().from(orders);
  return o!;
}

describe('startPayment (via flow submit)', () => {
  it('sends the Pay button with the link url and records a created payment', async () => {
    const { c, slotMap } = await setup();
    const o = await placeOrder(c, slotMap);
    expect(wa.sent).toHaveLength(1);
    const i = msgs()[0].interactive;
    expect(i.type).toBe('cta_url');
    expect(i.action.parameters.display_text).toBe('Pay ₹600');
    expect(i.action.parameters.url).toBe(`https://payments.test/links/${o.id}`);
    expect(i.body.text).toContain(o.orderCode);

    const [p] = await db.select().from(payments);
    expect(p).toMatchObject({
      tenantId: 'test',
      orderId: o.id,
      kind: 'link',
      status: 'created',
      providerRef: o.id,
      amountPaise: 60000,
      linkUrl: `https://payments.test/links/${o.id}`,
    });

    const call = pay.calls.find((x) => x.method === 'createPaymentLink') as any;
    expect(call.input).toMatchObject({
      linkId: o.id,
      amountPaise: 60000,
      purpose: `Order ${o.orderCode}`,
      customerPhone: '919811112222',
      customerName: 'Asha',
      notifyUrl: 'https://bot.test/webhooks/cashfree',
    });
    expect(call.input.expiresAt).toEqual(new Date(now.getTime() + 30 * 60_000));
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', async () => {
    const { c, slotMap } = await setup();
    deps = { ...deps, env: { ...deps.env, PUBLIC_BASE_URL: 'https://bot.test/' } };
    await placeOrder(c, slotMap);
    const call = pay.calls.find((x) => x.method === 'createPaymentLink') as any;
    expect(call.input.notifyUrl).toBe('https://bot.test/webhooks/cashfree');
  });

  it('link creation failure -> generic error, order stays pending, no payments row, no PII logged', async () => {
    const { c, slotMap } = await setup();
    pay.failNext = new Error('cashfree down');
    const error = vi.fn();
    deps = { ...deps, log: { ...deps.log, error } as any };
    const o = await placeOrder(c, slotMap);
    expect(msgs()).toHaveLength(1);
    expect(msgs()[0].text.body).toBe(tenant.copy.genericError());
    expect(o.status).toBe('payment_pending');
    expect(await db.select().from(payments)).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('Asha');
    expect(JSON.stringify(error.mock.calls)).not.toContain('919811112222');
  });
});

describe('confirmPaidOrder', () => {
  async function paidSetup(customerOverrides: Partial<typeof customers.$inferInsert> = {}) {
    const { c, slotMap } = await setup(customerOverrides);
    const o = await placeOrder(c, slotMap);
    wa.sent.length = 0;
    return { c, o };
  }

  it('PAID with the right amount confirms the order, sends confirmation then a location request', async () => {
    const { o } = await paidSetup();
    pay.setLink(o.id, 'PAID', 60000);
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('confirmed');

    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe('confirmed');
    expect(row!.paidAt).toEqual(now);
    const [p] = await db.select().from(payments);
    expect(p!.status).toBe('paid');

    expect(wa.sent).toHaveLength(2);
    const text = msgs()[0].text.body as string;
    expect(text).toContain(o.orderCode);
    expect(text).toContain('Wed, 18 Nov');
    expect(msgs()[1].interactive.type).toBe('location_request_message');
    expect(msgs()[1].interactive.body.text).toBe(tenant.copy.askLocation());
  });

  it('a customer who already has a location gets no location request', async () => {
    const { o } = await paidSetup({ defaultLocation: { lat: 12.9, lng: 77.6 } });
    pay.setLink(o.id, 'PAID', 60000);
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('confirmed');
    expect(wa.sent).toHaveLength(1);
    expect(msgs()[0].text.body).toContain(o.orderCode);
  });

  it('a failing location request does not fail the confirmation', async () => {
    const { o } = await paidSetup();
    pay.setLink(o.id, 'PAID', 60000);
    const send = wa.send.bind(wa);
    let n = 0;
    wa.send = async (...a: Parameters<typeof send>) => {
      if (++n === 2) throw new Error('boom');
      return send(...a);
    };
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('confirmed');
    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe('confirmed');
  });

  it('second call -> already, still exactly one confirmation', async () => {
    const { o } = await paidSetup();
    pay.setLink(o.id, 'PAID', 60000);
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('confirmed');
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('already');
    expect(wa.sent.filter((s) => (s.message as any).type === 'text')).toHaveLength(1);
  });

  it('concurrent calls confirm exactly once', async () => {
    const { o } = await paidSetup();
    pay.setLink(o.id, 'PAID', 60000);
    const results = await Promise.all([confirmPaidOrder(deps, tenant, o.id), confirmPaidOrder(deps, tenant, o.id)]);
    expect(results.filter((r) => r === 'confirmed')).toHaveLength(1);
    expect(results.filter((r) => r === 'already')).toHaveLength(1);
    expect(wa.sent.filter((s) => (s.message as any).type === 'text')).toHaveLength(1);
  });

  it('link ACTIVE -> not_paid, order stays pending', async () => {
    const { o } = await paidSetup();
    expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('not_paid');
    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe('payment_pending');
    expect(wa.sent).toHaveLength(0);
  });

  it('amount 59900 -> amount_mismatch, order and payment untouched', async () => {
    const { o } = await paidSetup();
    pay.setLink(o.id, 'PAID', 59900);
    const error = vi.fn();
    expect(await confirmPaidOrder({ ...deps, log: { ...deps.log, error } as any }, tenant, o.id)).toBe('amount_mismatch');
    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe('payment_pending');
    expect((await db.select().from(payments))[0]!.status).toBe('created');
    expect(error).toHaveBeenCalled();
    expect(wa.sent).toHaveLength(0);
  });

  describe('order closed before the payment arrived', () => {
    const close = (id: string) => db.update(orders).set({ status: 'expired' }).where(eq(orders.id, id));

    it('expired order + link PAID -> paid_after_close: payment paid, order unchanged, no message, error logged', async () => {
      const { o } = await paidSetup();
      await close(o.id);
      pay.setLink(o.id, 'PAID', 60000);
      const error = vi.fn();
      expect(await confirmPaidOrder({ ...deps, log: { ...deps.log, error } as any }, tenant, o.id)).toBe('paid_after_close');
      expect((await db.select().from(payments))[0]!.status).toBe('paid');
      expect((await db.select().from(orders).where(eq(orders.id, o.id)))[0]!.status).toBe('expired');
      expect(wa.sent).toHaveLength(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![1]).toBe('payment received for closed order; refund needed');
    });

    it('expired order + link not PAID -> already', async () => {
      const { o } = await paidSetup();
      await close(o.id);
      expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('already');
      expect((await db.select().from(payments))[0]!.status).toBe('created');
    });

    it('confirmed order -> already without calling the provider', async () => {
      const { o } = await paidSetup();
      pay.setLink(o.id, 'PAID', 60000);
      await confirmPaidOrder(deps, tenant, o.id);
      pay.calls.length = 0;
      expect(await confirmPaidOrder(deps, tenant, o.id)).toBe('already');
      expect(pay.calls).toHaveLength(0);
    });
  });

  it('unknown link id -> not_paid', async () => {
    await paidSetup();
    expect(await confirmPaidOrder(deps, tenant, 'nope')).toBe('not_paid');
  });
});
