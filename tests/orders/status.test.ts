import { eq } from 'drizzle-orm';
import { confirmPaidOrder } from '../../src/orders/checkout.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { deliveryPartners, orders, payments, messages } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import {
  InvalidTransitionError,
  NotSupportedError,
  OrderNotFoundError,
  PartnerUnavailableError,
  RefundNotPossibleError,
  refundIdFor,
  refundOrder,
  updateStatus,
} from '../../src/orders/order-status.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let pay: FakePaymentProvider;
let deps: AppDeps;
const tenant = testTenant();
const now = new Date('2026-11-12T06:00:00Z');
let n = 0;

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  wa = new FakeWhatsAppSender();
  pay = new FakePaymentProvider();
  deps = testDeps({ db, whatsapp: wa, payments: pay, now: () => now });
});

async function seedOrder(
  status: (typeof orders.$inferInsert)['status'],
  o: { source?: 'one_time' | 'subscription'; payment?: 'paid' | 'created' | 'refunded' | null; tenantId?: string } = {},
) {
  const tenantId = o.tenantId ?? 'test';
  if (tenantId !== 'test') await seedTenantRow(db, tenantId);
  const c = await seedCustomer(db, tenantId, { waId: '919811112222' });
  n++;
  const [order] = await db
    .insert(orders)
    .values({
      tenantId,
      orderCode: `TS-${n}`,
      customerId: c.id,
      source: o.source ?? 'one_time',
      status,
      deliveryDate: '2026-11-18',
      address: { name: 'Asha', line1: 'x', landmark: null, pincode: '560035', phone: null } as any,
      pincode: '560035',
      subtotalPaise: 60000,
      deliveryFeePaise: 0,
      totalPaise: 60000,
    })
    .returning();
  const pstatus = o.payment === undefined ? 'paid' : o.payment;
  if (pstatus) {
    await db.insert(payments).values({
      tenantId,
      orderId: order!.id,
      kind: 'link',
      status: pstatus,
      providerRef: order!.id,
      amountPaise: 60000,
    });
  }
  return order!;
}

async function seedPartner(overrides: Partial<typeof deliveryPartners.$inferInsert> = {}) {
  const [p] = await db
    .insert(deliveryPartners)
    .values({ tenantId: 'test', name: 'Ravi', phone: '919800000001', ...overrides })
    .returning();
  return p!;
}
const reload = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;

describe('updateStatus', () => {
  it('walks confirmed -> assigned -> out_for_delivery -> delivered and sends exactly one template', async () => {
    const o = await seedOrder('confirmed');
    const p = await seedPartner();
    expect((await updateStatus(deps, tenant, o.id, 'assigned', { partnerId: p.id })).order.assignedPartnerId).toBe(p.id);
    await updateStatus(deps, tenant, o.id, 'out_for_delivery');
    expect(wa.sent).toHaveLength(0);
    const r = await updateStatus(deps, tenant, o.id, 'delivered');
    expect(r.notified).toBe(true);
    const row = await reload(o.id);
    expect(row.status).toBe('delivered');
    expect(row.deliveredAt).toEqual(now);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe('919811112222');
    expect((wa.sent[0]!.message as any).template).toEqual({
      name: 'order_delivered',
      language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: o.orderCode }] }],
    });
    const logged = await db.select().from(messages);
    expect(logged.map((m) => m.text)).toContain(`[template order_delivered] ${o.orderCode}`);
  });

  it.each([
    ['payment_pending', 'delivered'],
    ['delivered', 'cancelled'],
    ['confirmed', 'out_for_delivery'],
    ['confirmed', 'delivered'],
    ['expired', 'cancelled'],
    ['cancelled', 'assigned'],
  ] as const)('rejects %s -> %s', async (from, to) => {
    const o = await seedOrder(from, { payment: null });
    const p = await seedPartner();
    await expect(updateStatus(deps, tenant, o.id, to, { partnerId: p.id })).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await reload(o.id)).status).toBe(from);
    expect(wa.sent).toHaveLength(0);
  });

  it('reassign changes the partner and keeps status assigned', async () => {
    const o = await seedOrder('confirmed');
    const a = await seedPartner();
    const b = await seedPartner({ name: 'Sunil', phone: '919800000002' });
    await updateStatus(deps, tenant, o.id, 'assigned', { partnerId: a.id });
    await updateStatus(deps, tenant, o.id, 'assigned', { partnerId: b.id });
    const row = await reload(o.id);
    expect(row.status).toBe('assigned');
    expect(row.assignedPartnerId).toBe(b.id);
  });

  it('assign needs a partner, which must be active and belong to the tenant', async () => {
    const o = await seedOrder('confirmed');
    await expect(updateStatus(deps, tenant, o.id, 'assigned')).rejects.toBeInstanceOf(PartnerUnavailableError);
    const inactive = await seedPartner({ active: false });
    await expect(updateStatus(deps, tenant, o.id, 'assigned', { partnerId: inactive.id })).rejects.toBeInstanceOf(PartnerUnavailableError);
    await seedTenantRow(db, 'other');
    const [foreign] = await db
      .insert(deliveryPartners)
      .values({ tenantId: 'other', name: 'X', phone: '919800000009' })
      .returning();
    await expect(updateStatus(deps, tenant, o.id, 'assigned', { partnerId: foreign!.id })).rejects.toBeInstanceOf(PartnerUnavailableError);
    expect((await reload(o.id)).status).toBe('confirmed');
  });

  it('a stale status loses the race with InvalidTransitionError and leaves consistent state', async () => {
    const o = await seedOrder('out_for_delivery');
    const results = await Promise.allSettled([
      updateStatus(deps, tenant, o.id, 'delivered'),
      updateStatus(deps, tenant, o.id, 'cancelled'),
    ]);
    const won = results.findIndex((r) => r.status === 'fulfilled');
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(lost.reason).toBeInstanceOf(InvalidTransitionError);
    const row = await reload(o.id);
    expect(row.status).toBe(won === 0 ? 'delivered' : 'cancelled');
    expect(wa.sent).toHaveLength(won === 0 ? 1 : 0);
  });

  it('cancel leaves a paid payment untouched and sends nothing', async () => {
    const o = await seedOrder('confirmed');
    await updateStatus(deps, tenant, o.id, 'cancelled');
    expect((await reload(o.id)).status).toBe('cancelled');
    expect((await db.select().from(payments))[0]!.status).toBe('paid');
    expect(wa.sent).toHaveLength(0);
    expect(pay.calls).toHaveLength(0);
  });

  it('delivered stays delivered when the template send fails, and logs without PII', async () => {
    const o = await seedOrder('out_for_delivery');
    wa.failNext = new Error('meta down');
    const error = vi.fn();
    deps = { ...deps, log: { ...deps.log, error } as any };
    const r = await updateStatus(deps, tenant, o.id, 'delivered');
    expect(r.notified).toBe(false);
    expect((await reload(o.id)).status).toBe('delivered');
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('919811112222');
    expect(JSON.stringify(error.mock.calls)).not.toContain('Asha');
  });

  it("another tenant's order is not found", async () => {
    const o = await seedOrder('confirmed', { tenantId: 'other' });
    await expect(updateStatus(deps, tenant, o.id, 'cancelled')).rejects.toBeInstanceOf(OrderNotFoundError);
    expect((await reload(o.id)).status).toBe('confirmed');
  });
});

describe('refundOrder', () => {
  it('refunds a paid confirmed order: provider once, payment refunded, order cancelled', async () => {
    const o = await seedOrder('confirmed');
    expect(await refundOrder(deps, tenant, o.id)).toBe('refunded');
    expect(pay.calls).toEqual([{ method: 'refundPaymentLink', linkId: o.id, amountPaise: 60000, refundId: refundIdFor(o.id) }]);
    expect(refundIdFor(o.id)).toMatch(/^[A-Za-z0-9_-]{3,40}$/);
    expect((await db.select().from(payments))[0]!.status).toBe('refunded');
    expect((await reload(o.id)).status).toBe('cancelled');
    expect(wa.sent).toHaveLength(0);
  });

  it.each(['delivered', 'expired', 'cancelled'] as const)('refund keeps a %s order status', async (status) => {
    const o = await seedOrder(status);
    expect(await refundOrder(deps, tenant, o.id)).toBe('refunded');
    expect((await reload(o.id)).status).toBe(status);
    expect((await db.select().from(payments))[0]!.status).toBe('refunded');
  });

  it('already refunded returns without calling the provider', async () => {
    const o = await seedOrder('cancelled', { payment: 'refunded' });
    expect(await refundOrder(deps, tenant, o.id)).toBe('already_refunded');
    expect(pay.calls).toHaveLength(0);
  });

  it('unpaid order throws and calls nothing', async () => {
    const o = await seedOrder('payment_pending', { payment: 'created' });
    await expect(refundOrder(deps, tenant, o.id)).rejects.toBeInstanceOf(RefundNotPossibleError);
    expect(pay.calls).toHaveLength(0);
  });

  it('order without a payment throws', async () => {
    const o = await seedOrder('confirmed', { payment: null });
    await expect(refundOrder(deps, tenant, o.id)).rejects.toBeInstanceOf(RefundNotPossibleError);
  });

  it('provider failure throws and leaves the DB unchanged', async () => {
    const o = await seedOrder('confirmed');
    pay.failNext = new Error('cashfree down');
    await expect(refundOrder(deps, tenant, o.id)).rejects.toThrow('cashfree down');
    expect((await db.select().from(payments))[0]!.status).toBe('paid');
    expect((await reload(o.id)).status).toBe('confirmed');
  });

  it('subscription orders are not supported', async () => {
    const o = await seedOrder('confirmed', { source: 'subscription' });
    await expect(refundOrder(deps, tenant, o.id)).rejects.toBeInstanceOf(NotSupportedError);
    expect(pay.calls).toHaveLength(0);
  });

  it("another tenant's order is not found", async () => {
    const o = await seedOrder('confirmed', { tenantId: 'other' });
    await expect(refundOrder(deps, tenant, o.id)).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(pay.calls).toHaveLength(0);
  });

  it.each(['assigned', 'out_for_delivery'] as const)('refund cancels a %s order', async (status) => {
    const o = await seedOrder(status);
    await refundOrder(deps, tenant, o.id);
    expect((await reload(o.id)).status).toBe('cancelled');
  });

  it('refunds a payment_failed order with a paid payment without changing its status', async () => {
    const o = await seedOrder('payment_failed');
    expect(await refundOrder(deps, tenant, o.id)).toBe('refunded');
    expect((await reload(o.id)).status).toBe('payment_failed');
  });

  it('concurrent refunds end with one refunded payment and a cancelled order', async () => {
    const o = await seedOrder('confirmed');
    await Promise.all([refundOrder(deps, tenant, o.id), refundOrder(deps, tenant, o.id)]);
    expect((await db.select().from(payments))[0]!.status).toBe('refunded');
    expect((await reload(o.id)).status).toBe('cancelled');
  });

  it('DB failure after provider success logs and throws a re-run message', async () => {
    const o = await seedOrder('confirmed');
    const error = vi.fn();
    const failingDb = { ...db, select: db.select.bind(db), transaction: async () => { throw new Error('db gone'); } } as any;
    const d = { ...deps, db: failingDb, log: { ...deps.log, error } as any };
    await expect(refundOrder(d, tenant, o.id)).rejects.toThrow(/re-run/);
    expect(error).toHaveBeenCalledTimes(1);
    expect(pay.calls).toHaveLength(1);
  });
});

describe('redelivered PAID webhook after a refund', () => {
  it.each(['confirmed', 'delivered', 'expired'] as const)('keeps the payment refunded (%s order)', async (status) => {
    const o = await seedOrder(status);
    await refundOrder(deps, tenant, o.id);
    const error = vi.fn();
    const d = { ...deps, log: { ...deps.log, error } as any };
    pay.setLink(o.id, 'PAID', 60000);
    expect(await confirmPaidOrder(d, tenant, o.id)).toBe('already');
    expect((await db.select().from(payments))[0]!.status).toBe('refunded');
    expect(error).not.toHaveBeenCalled();
    expect((await reload(o.id)).status).toBe(status === 'confirmed' ? 'cancelled' : status);
  });
});
