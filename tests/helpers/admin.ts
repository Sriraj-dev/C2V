import type { Hono } from 'hono';
import { createSession } from '../../src/admin/auth/session-repo.js';
import { createVendor } from '../../src/admin/auth/vendor-repo.js';
import { hashPassword } from '../../src/admin/auth/password.js';
import { buildApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import type { VendorUserRow } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { registerTenants, resetTenantsForTests } from '../../src/tenants/registry.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from './fakes.js';
import { createTestDb, seedTenantRow, testTenant } from './test-db.js';

export interface AdminLogin {
  headers: { authorization: string };
  vendor: VendorUserRow;
  token: string;
  /** The plaintext password the vendor was created with. */
  password: string;
}

export interface AdminTest {
  db: Db;
  deps: AppDeps;
  app: Hono;
  wa: FakeWhatsAppSender;
  pay: FakePaymentProvider;
  /** Creates a vendor (unique username) + session for the tenant directly via the repos. */
  login(tenantId?: string): Promise<AdminLogin>;
}

/** Call from `beforeEach` (hook timeout), not inside a test body: the first call boots PGlite.
 * Fresh DB, tenants `test` and `other` registered and seeded, and an app wired with fakes. */
export async function setupAdminTest(): Promise<AdminTest> {
  const db = await createTestDb();
  resetTenantsForTests();
  registerTenants([testTenant(), testTenant({ id: 'other', name: 'Other Tenant', waPhoneNumberId: 'other-phone' })]);
  await seedTenantRow(db, 'test');
  await seedTenantRow(db, 'other');
  const wa = new FakeWhatsAppSender();
  const pay = new FakePaymentProvider();
  const deps = testDeps({ db, whatsapp: wa, payments: pay });
  const app = buildApp(deps);
  let n = 0;
  return {
    db,
    deps,
    app,
    wa,
    pay,
    async login(tenantId = 'test') {
      const password = 'correct-horse-battery';
      const vendor = await createVendor(db, {
        tenantId,
        username: `vendor${++n}-${tenantId}`,
        passwordHash: await hashPassword(password),
      });
      const { token } = await createSession(db, { vendorUserId: vendor.id, tenantId, now: deps.now() });
      return { headers: { authorization: `Bearer ${token}` }, vendor, token, password };
    },
  };
}
