/* eslint-disable @typescript-eslint/no-explicit-any */
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { orders, payments, subscriptionItems, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { raiseDueCharges } from '../../src/subscriptions/charges.js';
import type { TenantConfig } from '../../src/tenants/types.js';
import type { FakePaymentProvider, FakeWhatsAppSender } from '../helpers/fakes.js';
import { seedCustomer, seedProduct } from '../helpers/test-db.js';

/** Mon 23 Nov 2026 10:00 IST: D-2 for a Wednesday 25 Nov delivery. */
export const MON_23_10AM = new Date('2026-11-23T04:30:00Z');

/**
 * An active weekly Wednesday subscription (1 × ₹168) whose upcoming charge for 25 Nov was raised by the real job:
 * order payment_pending, payment created, Cashfree charge INITIALIZED, next delivery 2 Dec. Clears sent messages.
 */
export async function raisedCharge(db: Db, deps: AppDeps, tenant: TenantConfig, pay: FakePaymentProvider, wa: FakeWhatsAppSender) {
  const p = await seedProduct(db, 'test', { name: '12 pack', pricePaise: 16800 });
  const c = await seedCustomer(db, 'test', { waId: '919811112222', waKey: '919811112222' });
  const [s] = await db
    .insert(subscriptions)
    .values({ tenantId: 'test', customerId: c.id, status: 'active', frequency: 'weekly', address: { name: 'Asha', line1: '12 MG Rd', pincode: '560035' } as any, pincode: '560035', deliveryWeekday: 3, perDeliveryTotalPaise: 16800, nextDeliveryDate: '2026-11-25' })
    .returning();
  await db.insert(subscriptionItems).values({ subscriptionId: s!.id, productId: p.id, quantity: 1 });
  pay.setSubscription(s!.id, 'ACTIVE', 'ACTIVE');
  await raiseDueCharges(deps, tenant, { sleep: async () => {} });
  const [payment] = await db.select().from(payments);
  const [order] = await db.select().from(orders);
  wa.sent.length = 0;
  pay.calls.length = 0;
  return { c, s: s!, payment: payment!, order: order! };
}

export const paymentStatus = async (db: Db, id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0]!.status;
export const orderOf = async (db: Db, id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
