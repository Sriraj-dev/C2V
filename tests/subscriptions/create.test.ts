/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { onSubscribeFlowSubmit } from '../../src/bot/subscribe-flow-handler.js';
import { encodeOrderFlowToken, encodeSubscribeFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Customer } from '../../src/customers/customer-repo.js';
import type { Db } from '../../src/db/client.js';
import { customers, subscriptionItems, subscriptions, tenants } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { CashfreeError } from '../../src/payments/cashfree/client.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedPincode, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
const tenant = testTenant();
// Mon 16 Nov 2026 10:00 IST; Wednesday (3) delivery → first delivery Wed 18 Nov.
const now = new Date('2026-11-16T04:30:00Z');

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 3000, minOrderPaise: 9000 });
  await seedPincode(db, 'test', '560035', 3);
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => now });
});

type Submit = Extract<InboundMessage, { kind: 'flow_submit' }>;
const submit = (c: Customer, slotMap: Record<string, string>, response: Record<string, unknown>, token?: string): Submit => ({
  kind: 'flow_submit',
  flowToken: token ?? encodeSubscribeFlowToken(c.id, slotMap),
  response,
  phoneNumberId: 'p',
  waMessageId: 'w',
  timestamp: 0,
  from: { waId: c.waId, bsuid: c.bsuid, profileName: null },
  raw: {},
});
const form = { name: 'Asha', line1: '12 MG Rd', landmark: '', pincode: '560035', frequency: 'biweekly', email: ' asha@example.com ' };
const text = (i = 0) => (wa.sent[i]!.message as any).text?.body as string;
const subCount = async () => (await db.select().from(subscriptions)).length;

async function setup(customer: Partial<typeof customers.$inferInsert> = { waId: '919811112222' }) {
  const p6 = await seedProduct(db, 'test', { name: '6 pack', pricePaise: 9000 });
  const p30 = await seedProduct(db, 'test', { name: '30 pack', pricePaise: 42000 });
  const c = await seedCustomer(db, 'test', customer);
  return { p6, p30, c, slotMap: { '1': p6.id, '2': p30.id } };
}

describe('onSubscribeFlowSubmit', () => {
  it('saves a pending subscription with items, creates the mandate and sends the AutoPay button', async () => {
    const { c, slotMap, p6, p30 } = await setup();
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '2', qty_2: '1' }));
    const [s] = await db.select().from(subscriptions);
    expect(s).toMatchObject({
      status: 'pending_authorization',
      frequency: 'biweekly',
      deliveryWeekday: 3,
      pincode: '560035',
      perDeliveryTotalPaise: 63000,
      cfSubscriptionId: `cf-${s!.id}`,
      cfSessionId: `sess-${s!.id}`,
      nextDeliveryDate: null,
    });
    expect(s!.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const items = await db.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, s!.id));
    expect(items.map((i) => [i.productId, i.quantity]).sort()).toEqual([[p6.id, 2], [p30.id, 1]].sort());

    const call = pay.calls.find((x) => x.method === 'createSubscription') as any;
    expect(call.input).toMatchObject({
      subscriptionId: s!.id,
      maxAmountPaise: 126000,
      customer: { name: 'Asha', email: 'asha@example.com', phone: '919811112222' },
      returnUrl: `https://bot.test/subscribe/${s!.authToken}/done`,
    });
    expect(call.input.expiresAt.getUTCFullYear()).toBe(2036);

    const msg = wa.sent[0]!.message as any;
    expect(msg.interactive.type).toBe('cta_url');
    expect(msg.interactive.action.parameters.display_text).toBe('Set up AutoPay');
    expect(msg.interactive.action.parameters.url).toBe(`https://bot.test/subscribe/${s!.authToken}`);
    const body = msg.interactive.body.text as string;
    expect(body).toContain('*₹630* per delivery, every 2 weeks on Wednesday.');
    expect(body).toContain('First delivery: Wed, 18 Nov');

    const [cust] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(cust!.email).toBe('asha@example.com');
    expect(cust!.defaultAddress).toMatchObject({ name: 'Asha', pincode: '560035' });
  });

  it.each([
    ['bad email', { email: 'asha@' }, 'invalidEmail'],
    ['missing email', { email: '' }, 'invalidEmail'],
    ['unknown frequency', { frequency: 'daily' }, 'invalidAddress'],
    ['no items', { qty_1: '0' }, 'noItems'],
  ])('%s → message, no subscription, no mandate', async (_n, patch, copyKey) => {
    const { c, slotMap } = await setup();
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1', ...patch }));
    expect(text()).toBe((tenant.copy as any)[copyKey]());
    expect(await subCount()).toBe(0);
    expect(pay.calls).toHaveLength(0);
  });

  it('below the minimum order → message, no subscription', async () => {
    const { c, slotMap } = await setup();
    await db.update(tenants).set({ minOrderPaise: 50000 }).where(eq(tenants.id, 'test'));
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }));
    expect(text()).toBe(tenant.copy.belowMinimum('₹500'));
    expect(await subCount()).toBe(0);
  });

  it('unserviceable pincode → message, no subscription', async () => {
    const { c, slotMap } = await setup();
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, pincode: '560001', qty_1: '1' }));
    expect(text()).toBe(tenant.copy.notServiceable('560001'));
    expect(await subCount()).toBe(0);
  });

  it('BSUID-only customer must give a valid phone; it is used for the mandate', async () => {
    const { c, slotMap } = await setup({ waId: null, waKey: 'bsuid-x', bsuid: 'bsuid-x' });
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1', phone: '12345' }));
    expect(text()).toBe(tenant.copy.invalidPhone());
    expect(await subCount()).toBe(0);
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1', phone: '98765 43210' }));
    const call = pay.calls.find((x) => x.method === 'createSubscription') as any;
    expect(call.input.customer.phone).toBe('9876543210');
  });

  it('Cashfree failure → no subscription or items left, generic error', async () => {
    const { c, slotMap } = await setup();
    pay.failNext = new CashfreeError('Cashfree 500: down', 500);
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }));
    expect(text()).toBe(tenant.copy.genericError());
    expect(await subCount()).toBe(0);
    expect(await db.select().from(subscriptionItems)).toHaveLength(0);
  });

  it('an order token or another customer token → menu, nothing created', async () => {
    const { c, slotMap } = await setup();
    const other = await seedCustomer(db, 'test', { waId: '919800000009' });
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }, encodeSubscribeFlowToken(other.id, slotMap)));
    await onSubscribeFlowSubmit(deps, tenant, c, submit(c, slotMap, { ...form, qty_1: '1' }, encodeOrderFlowToken(c.id, slotMap)));
    expect(wa.sent.every((s) => (s.message as any).interactive?.type === 'list')).toBe(true);
    expect(await subCount()).toBe(0);
  });
});
