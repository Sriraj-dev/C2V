import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import type { Db } from '../../src/db/client.js';
import { customers, messages, orders, payments, subscriptions } from '../../src/db/schema.js';
import {
  seedTenantRow,
  seedCustomer,
  seedProduct,
  seedPincode,
} from '../helpers/test-db.js';

const address = { name: 'A', line1: 'B', pincode: '560034' };

describe('schema constraints', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
    await seedTenantRow(db);
  });

  it('rejects duplicate (tenant_id, wa_key) customers', async () => {
    await seedCustomer(db, 'test', { waKey: 'dup' });
    await expect(seedCustomer(db, 'test', { waKey: 'dup' })).rejects.toThrow();
  });

  it('rejects duplicate wa_message_id', async () => {
    const c = await seedCustomer(db, 'test');
    const row = {
      tenantId: 'test',
      customerId: c.id,
      direction: 'in' as const,
      waMessageId: 'wamid.1',
      type: 'text',
      payload: {},
    };
    await db.insert(messages).values(row);
    await expect(db.insert(messages).values(row)).rejects.toThrow();
  });

  it('rejects duplicate (subscription_id, for_delivery_date) payments', async () => {
    const c = await seedCustomer(db, 'test');
    const [sub] = await db
      .insert(subscriptions)
      .values({
        tenantId: 'test',
        customerId: c.id,
        status: 'active',
        address,
        pincode: '560034',
        deliveryWeekday: 3,
        perDeliveryTotalPaise: 9000,
      })
      .returning();
    const base = {
      tenantId: 'test',
      subscriptionId: sub!.id,
      forDeliveryDate: '2026-12-02',
      provider: 'cashfree',
      kind: 'subscription_charge' as const,
      amountPaise: 9000,
      status: 'created' as const,
    };
    await db.insert(payments).values({ ...base, providerRef: 'p1' });
    await expect(db.insert(payments).values({ ...base, providerRef: 'p2' })).rejects.toThrow();
  });

  it('rejects duplicate (tenant_id, order_code) orders', async () => {
    const c = await seedCustomer(db, 'test');
    await seedProduct(db, 'test');
    await seedPincode(db, 'test', '560034', 3);
    const row = {
      tenantId: 'test',
      orderCode: 'NF-ABC234',
      customerId: c.id,
      source: 'one_time' as const,
      status: 'payment_pending' as const,
      deliveryDate: '2026-12-02',
      address,
      pincode: '560034',
      subtotalPaise: 9000,
      deliveryFeePaise: 0,
      totalPaise: 9000,
    };
    await db.insert(orders).values(row);
    await expect(db.insert(orders).values(row)).rejects.toThrow();
  });

  it('seed customer is queryable', async () => {
    const rows = await db.select().from(customers);
    expect(rows.length).toBeGreaterThan(0);
  });
});
