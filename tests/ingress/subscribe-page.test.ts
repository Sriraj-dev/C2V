import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { subscriptions } from '../../src/db/schema.js';
import { CashfreeError } from '../../src/payments/cashfree/client.js';
import { registerTenants, resetTenantsForTests } from '../../src/tenants/registry.js';
import { FakePaymentProvider, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../helpers/test-db.js';

const tenant = testTenant();
const TOKEN = 'a'.repeat(43);
let db: Db;
let pay: FakePaymentProvider;
let app: ReturnType<typeof buildApp>;
let subId: string;

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  resetTenantsForTests();
  registerTenants([tenant]);
  pay = new FakePaymentProvider();
  app = buildApp(testDeps({ db, payments: pay }));
  const c = await seedCustomer(db, 'test', { waId: '919811112222' });
  const [s] = await db
    .insert(subscriptions)
    .values({
      tenantId: 'test',
      customerId: c.id,
      status: 'pending_authorization',
      address: { name: 'Asha', line1: 'x', pincode: '560035' },
      pincode: '560035',
      deliveryWeekday: 3,
      perDeliveryTotalPaise: 9000,
      authToken: TOKEN,
      cfSessionId: 'stored-sess',
    })
    .returning();
  subId = s!.id;
});
afterEach(() => resetTenantsForTests());

const get = (path: string) => app.request(path);

describe('GET /subscribe/:token', () => {
  it('pending subscription → checkout page with a fresh session, sandbox mode and safe headers', async () => {
    const res = await get(`/subscribe/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('https://sdk.cashfree.com/js/v3/cashfree.js');
    expect(html).toContain(`subsSessionId:"fresh-sess-${subId}"`);
    expect(html).toContain('mode:"sandbox"');
    expect(html).not.toContain('stored-sess');
  });

  it('Cashfree fetch failing → falls back to the stored session', async () => {
    pay.failNext = new CashfreeError('down', 500);
    const html = await (await get(`/subscribe/${TOKEN}`)).text();
    expect(html).toContain('subsSessionId:"stored-sess"');
  });

  it('already approved at Cashfree, or not pending locally → inactive page', async () => {
    pay.setSubscription(subId, 'ACTIVE', 'ACTIVE');
    expect(await (await get(`/subscribe/${TOKEN}`)).text()).toContain('no longer active');
    pay.setSubscription(subId, 'INITIALIZED');
    await db.update(subscriptions).set({ status: 'active' }).where(eq(subscriptions.id, subId));
    const html = await (await get(`/subscribe/${TOKEN}`)).text();
    expect(html).toContain('no longer active');
    expect(html).not.toContain('subsSessionId');
  });

  it('junk or unknown token → 404 without calling Cashfree', async () => {
    expect((await get('/subscribe/short')).status).toBe(404);
    expect((await get(`/subscribe/${'b'.repeat(43)}`)).status).toBe(404);
    expect(pay.calls).toHaveLength(0);
  });

  it('done page', async () => {
    const res = await get(`/subscribe/${TOKEN}/done`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('return to WhatsApp');
  });
});
