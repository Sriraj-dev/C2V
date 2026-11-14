import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onLocationShared } from '../../src/bot/location.js';
import type { Db } from '../../src/db/client.js';
import { customers, orders, subscriptions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedPincode, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';
import { createOrder } from '../../src/orders/order-service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
const tenant = testTenant();

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { deliveryFeePaise: 0 });
  await seedPincode(db, 'test', '560035', 3);
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa });
});

async function mkOrder(customerId: string, status: 'payment_pending' | 'confirmed') {
  const p = await seedProduct(db, 'test');
  const c = (await db.select().from(customers).where(eq(customers.id, customerId)))[0]!;
  return createOrder(deps, tenant, c, {
    lines: [{ product: p, quantity: 1 }],
    address: { name: 'A', line1: 'x', pincode: '560035' },
    location: null,
    status,
    source: 'one_time',
    deliveryDate: '2026-11-18',
  });
}

describe('onLocationShared', () => {
  it('saves the customer location, updates confirmed orders and active subscriptions, replies once', async () => {
    const c = await seedCustomer(db, 'test', { waId: '919811112222' });
    const other = await seedCustomer(db, 'test', { waId: '919800000000' });
    const confirmed = await mkOrder(c.id, 'confirmed');
    const pending = await mkOrder(c.id, 'payment_pending');
    const othersOrder = await mkOrder(other.id, 'confirmed');
    const [sub] = await db
      .insert(subscriptions)
      .values({
        tenantId: 'test',
        customerId: c.id,
        status: 'active',
        address: { name: 'A', line1: 'x', pincode: '560035' },
        pincode: '560035',
        deliveryWeekday: 3,
        perDeliveryTotalPaise: 9000,
      } as any)
      .returning();

    await onLocationShared(deps, tenant, c, { kind: 'location', lat: 12.9, lng: 77.6 } as any);

    const [saved] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(saved!.defaultLocation).toEqual({ lat: 12.9, lng: 77.6 });
    const loc = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!.location;
    expect(await loc(confirmed.id)).toEqual({ lat: 12.9, lng: 77.6 });
    expect(await loc(pending.id)).toBeNull();
    expect(await loc(othersOrder.id)).toBeNull();
    const [s] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(s!.location).toEqual({ lat: 12.9, lng: 77.6 });

    expect(wa.sent).toHaveLength(1);
    expect((wa.sent[0]!.message as any).text.body).toBe(tenant.copy.locationSaved());
  });

  it.each([
    [91, 10],
    [-91, 10],
    [10, 181],
    [10, -181],
    [NaN, 10],
    [10, Infinity],
  ])('ignores out-of-range or non-finite coordinates (%s, %s)', async (lat, lng) => {
    const c = await seedCustomer(db, 'test', { waId: '919811112222' });
    const warn = vi.fn();
    await onLocationShared({ ...deps, log: { ...deps.log, warn } as any }, tenant, c, { kind: 'location', lat, lng } as any);
    const [saved] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(saved!.defaultLocation).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(wa.sent).toHaveLength(1);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
  });
});
