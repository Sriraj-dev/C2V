/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleInbound } from '../../src/bot/router.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Db } from '../../src/db/client.js';
import { orders, payments, tenants } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { skipCharge } from '../../src/subscriptions/charge-results.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../helpers/test-db.js';
import { MON_23_10AM, orderOf, paymentStatus, raisedCharge } from './charge-fixture.js';

let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
const tenant = testTenant();
const SUPPORT = '+91 98765 43210';

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0, minOrderPaise: 0, supportPhone: SUPPORT });
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => MON_23_10AM });
});

const texts = () => wa.sent.map((m) => (m.message as any).text?.body as string | undefined);
const cancels = () => pay.calls.filter((x) => x.method === 'cancelCharge');
const DONE = () => tenant.copy.skipDone({ date: 'Wed, 25 Nov', next: 'Wed, 2 Dec' });

describe('skipCharge', () => {
  it('skips an uncollected charge: cancelled at Cashfree, payment and order cancelled, skipDone with the next date', async () => {
    const { c, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    await skipCharge(deps, tenant, c, payment.id);
    expect(cancels()).toHaveLength(1);
    expect(await paymentStatus(db, payment.id)).toBe('cancelled');
    expect((await orderOf(db, order.id)).status).toBe('cancelled');
    expect(texts()).toEqual([DONE()]);
  });

  it('skip twice → one cancel call, same reply', async () => {
    const { c, payment } = await raisedCharge(db, deps, tenant, pay, wa);
    await skipCharge(deps, tenant, c, payment.id);
    await skipCharge(deps, tenant, c, payment.id);
    expect(cancels()).toHaveLength(1);
    expect(texts()).toEqual([DONE(), DONE()]);
  });

  it('cancel refused and Cashfree says SUCCESS → order confirmed, payment paid, already-paid with support number', async () => {
    const { c, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'SUCCESS');
    pay.refuseCancelCharge = new Error('payment_status_invalid_for_action');
    await skipCharge(deps, tenant, c, payment.id);
    expect(await paymentStatus(db, payment.id)).toBe('paid');
    expect((await orderOf(db, order.id)).status).toBe('confirmed');
    expect(texts()).toEqual([tenant.copy.skipAlreadyPaid({ orderCode: order.orderCode, supportPhone: SUPPORT })]);
    expect(texts()[0]).toContain(SUPPORT);
  });

  it('order already confirmed → already-paid, no Cashfree call', async () => {
    const { c, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    await db.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, order.id));
    await skipCharge(deps, tenant, c, payment.id);
    expect(pay.calls).toHaveLength(0);
    expect(texts()).toEqual([tenant.copy.skipAlreadyPaid({ orderCode: order.orderCode, supportPhone: SUPPORT })]);
  });

  it('cancel refused while the bank is processing → processing text, nothing changed', async () => {
    const { c, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    pay.charges.set(payment.id, 'PENDING');
    pay.refuseCancelCharge = new Error('payment_status_invalid_for_action');
    await skipCharge(deps, tenant, c, payment.id);
    expect(await paymentStatus(db, payment.id)).toBe('created');
    expect((await orderOf(db, order.id)).status).toBe('payment_pending');
    expect(texts()).toEqual([tenant.copy.skipProcessing({ supportPhone: SUPPORT })]);
  });

  it('no support phone set → points to Help', async () => {
    const { c, payment } = await raisedCharge(db, deps, tenant, pay, wa);
    await db.update(tenants).set({ supportPhone: null }).where(eq(tenants.id, 'test'));
    pay.charges.set(payment.id, 'PENDING');
    pay.refuseCancelCharge = new Error('in progress');
    await skipCharge(deps, tenant, c, payment.id);
    expect(texts()[0]).toContain('*Help*');
  });

  it('skip on a failed charge (UPI retries pending) → retries cancelled, order cancelled', async () => {
    const { c, payment, order } = await raisedCharge(db, deps, tenant, pay, wa);
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.id, payment.id));
    await db.update(orders).set({ status: 'payment_failed' }).where(eq(orders.id, order.id));
    await skipCharge(deps, tenant, c, payment.id);
    expect(cancels()).toHaveLength(1);
    expect(await paymentStatus(db, payment.id)).toBe('cancelled');
    expect((await orderOf(db, order.id)).status).toBe('cancelled');
    expect(texts()).toEqual([DONE()]);
  });

  it("another customer's payment id → menu, no Cashfree call", async () => {
    const { payment } = await raisedCharge(db, deps, tenant, pay, wa);
    const other = await seedCustomer(db, 'test', { waId: '919800000000' });
    await skipCharge(deps, tenant, other, payment.id);
    expect(pay.calls).toHaveLength(0);
    expect(await paymentStatus(db, payment.id)).toBe('created');
    expect(wa.sent).toHaveLength(1);
    expect(texts()[0]).toBeUndefined(); // the menu is an interactive message
  });

  it('the template quick reply reaches skip through the router', async () => {
    const { c, payment } = await raisedCharge(db, deps, tenant, pay, wa);
    const msg = {
      kind: 'button',
      replyId: `skip:${payment.id}`,
      title: 'Skip this delivery',
      phoneNumberId: 'p',
      waMessageId: 'wamid.skip1',
      timestamp: 1,
      from: { waId: c.waId, bsuid: null, profileName: 'Asha' },
      raw: {},
    } as unknown as InboundMessage;
    await handleInbound(deps, tenant, msg);
    expect(await paymentStatus(db, payment.id)).toBe('cancelled');
    expect(texts()).toEqual([DONE()]);
  });
});
