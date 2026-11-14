import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onOrderFlowSubmit } from '../../src/bot/order-flow-handler.js';
import { buildApp } from '../../src/app.js';
import { encodeOrderFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Db } from '../../src/db/client.js';
import { orders, payments } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { registerTenants, resetTenantsForTests } from '../../src/tenants/registry.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedPincode, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SECRET = 'cf-test-secret';
const tenant = testTenant();
let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  process.env.TEST_CF_SECRET = SECRET;
  registerTenants([tenant]);
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0 });
  await seedPincode(db, 'test', '560035', 3);
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => new Date('2026-11-12T06:00:00Z') });
  app = buildApp(deps);
});
afterEach(() => {
  delete process.env.TEST_CF_SECRET;
  resetTenantsForTests();
});

const sign = (body: string, ts: string, secret = SECRET) =>
  createHmac('sha256', secret).update(ts + body).digest('base64');

function post(body: string, opts: { sig?: string | null; ts?: string | null } = {}) {
  const ts = opts.ts === undefined ? '1700000000000' : opts.ts;
  const sig = opts.sig === undefined ? sign(body, ts ?? '') : opts.sig;
  const headers: Record<string, string> = {};
  if (ts !== null) headers['x-webhook-timestamp'] = ts;
  if (sig !== null) headers['x-webhook-signature'] = sig;
  return app.request('/webhooks/cashfree', { method: 'POST', body, headers });
}

const linkEvent = (linkId: string, status = 'PAID') =>
  JSON.stringify({ type: 'PAYMENT_LINK_EVENT', version: 1, data: { link_id: linkId, link_status: status } });

async function placeOrder() {
  const p = await seedProduct(db, 'test', { name: '6 pack', pricePaise: 9000 });
  const c = await seedCustomer(db, 'test', { waId: '919811112222' });
  const msg = {
    kind: 'flow_submit',
    flowToken: encodeOrderFlowToken(c.id, { '1': p.id }),
    response: { name: 'Asha', line1: '12 MG Rd', pincode: '560035', qty_1: '2' },
    phoneNumberId: 'p',
    waMessageId: 'w',
    timestamp: 0,
    from: { waId: c.waId, bsuid: null, profileName: null },
    raw: {},
  } as Extract<InboundMessage, { kind: 'flow_submit' }>;
  await onOrderFlowSubmit(deps, tenant, c, msg);
  wa.sent.length = 0;
  return (await db.select().from(orders))[0]!;
}
const status = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!.status;

describe('POST /webhooks/cashfree', () => {
  it('valid signature + PAID link confirms the order, sends confirmation then location request', async () => {
    const o = await placeOrder();
    pay.setLink(o.id, 'PAID', 18000);
    const res = await post(linkEvent(o.id));
    expect(res.status).toBe(200);
    expect(await status(o.id)).toBe('confirmed');
    expect(wa.sent).toHaveLength(2);
    expect((wa.sent[0]!.message as any).text.body).toContain(o.orderCode);
    expect((wa.sent[1]!.message as any).interactive.type).toBe('location_request_message');
  });

  it('works with the real fixture shape and its raw body', async () => {
    const o = await placeOrder();
    pay.setLink(o.id, 'PAID', 18000);
    const body = readFileSync('tests/payments/cashfree/fixtures/payment-link-paid.json', 'utf8').replace('c2v_ord_8f3a', o.id);
    expect((await post(body)).status).toBe(200);
    expect(await status(o.id)).toBe('confirmed');
  });

  it('same webhook again -> still exactly one confirmation', async () => {
    const o = await placeOrder();
    pay.setLink(o.id, 'PAID', 18000);
    await post(linkEvent(o.id));
    expect((await post(linkEvent(o.id))).status).toBe(200);
    expect(wa.sent.filter((s) => (s.message as any).type === 'text')).toHaveLength(1);
  });

  it('bad, missing or wrong-secret signature -> 401 and nothing changes', async () => {
    const o = await placeOrder();
    pay.setLink(o.id, 'PAID', 18000);
    const body = linkEvent(o.id);
    expect((await post(body, { sig: 'AAAA' })).status).toBe(401);
    expect((await post(body, { sig: null })).status).toBe(401);
    expect((await post(body, { ts: null, sig: sign(body, '1700000000000') })).status).toBe(401);
    expect((await post(body, { sig: sign(body, '1700000000000', 'other') })).status).toBe(401);
    expect((await post(body, { sig: sign(body.replace('PAID', 'PAID '), '1700000000000') })).status).toBe(401);
    expect(await status(o.id)).toBe('payment_pending');
    expect((await db.select().from(payments))[0]!.status).toBe('created');
    expect(wa.sent).toHaveLength(0);
  });

  it('401 when the tenant secret env var is not set', async () => {
    const o = await placeOrder();
    delete process.env.TEST_CF_SECRET;
    expect((await post(linkEvent(o.id))).status).toBe(401);
    expect(await status(o.id)).toBe('payment_pending');
  });

  it('unknown link id -> 200, nothing changes', async () => {
    const o = await placeOrder();
    expect((await post(linkEvent('does-not-exist'))).status).toBe(200);
    expect(await status(o.id)).toBe('payment_pending');
    expect(wa.sent).toHaveLength(0);
  });

  it('payment for a tenant that is no longer registered -> 200, nothing changes', async () => {
    const o = await placeOrder();
    resetTenantsForTests();
    expect((await post(linkEvent(o.id))).status).toBe(200);
    expect(await status(o.id)).toBe('payment_pending');
  });

  it('invalid JSON -> 400', async () => {
    expect((await post('{not json')).status).toBe(400);
  });

  it('link not PAID -> 200, order stays pending', async () => {
    const o = await placeOrder();
    expect((await post(linkEvent(o.id, 'ACTIVE'))).status).toBe(200);
    expect(await status(o.id)).toBe('payment_pending');
  });

  it('subscription event with unknown subscription -> 200', async () => {
    const body = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: { subscription_details: { subscription_id: 'sub_1', subscription_status: 'ACTIVE' } },
    });
    expect((await post(body)).status).toBe(200);
  });

  it('subscription event for a known subscription: bad signature -> 401, good -> 200', async () => {
    const c = await seedCustomer(db, 'test', { waId: '919811112222' });
    const { subscriptions } = await import('../../src/db/schema.js');
    const [sub] = await db.insert(subscriptions).values({
      tenantId: 'test',
      customerId: c.id,
      status: 'pending_authorization',
      address: { name: 'A', line1: 'x', pincode: '560035' },
      pincode: '560035',
      deliveryWeekday: 3,
      perDeliveryTotalPaise: 9000,
    } as any).returning();
    const body = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: { subscription_details: { subscription_id: sub!.id, subscription_status: 'ACTIVE' } },
    });
    expect((await post(body, { sig: 'bad' })).status).toBe(401);
    expect((await post(body)).status).toBe(200);
  });

  it('non-uuid subscription id -> 200 (unknown), no handler error', async () => {
    const body = JSON.stringify({
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: { subscription_details: { subscription_id: 'not-a-uuid', subscription_status: 'ACTIVE' } },
    });
    const error = vi.fn();
    app = buildApp({ ...deps, log: { ...deps.log, error } as any });
    expect((await post(body)).status).toBe(200);
    expect(error).not.toHaveBeenCalled();
  });

  it('oversized body -> 413', async () => {
    const body = JSON.stringify({ type: 'WEBHOOK_TEST', pad: 'x'.repeat(70 * 1024) });
    const res = await app.request('/webhooks/cashfree', {
      method: 'POST',
      body,
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    });
    expect(res.status).toBe(413);
  });

  it('ignored event types -> 200', async () => {
    expect((await post(JSON.stringify({ type: 'WEBHOOK_TEST' }))).status).toBe(200);
  });

  it('handler errors are logged and still return 200', async () => {
    const o = await placeOrder();
    pay.failNext = new Error('cashfree down');
    expect((await post(linkEvent(o.id))).status).toBe(200);
    expect(await status(o.id)).toBe('payment_pending');
  });
});
