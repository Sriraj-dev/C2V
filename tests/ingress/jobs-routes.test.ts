import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { registerTenants, resetTenantsForTests } from '../../src/tenants/registry.js';
import { FakePaymentProvider, FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedTenantRow, testTenant } from '../helpers/test-db.js';

let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  registerTenants([testTenant()]);
  const db = await createTestDb();
  await seedTenantRow(db, 'test');
  const deps = testDeps({ db, whatsapp: new FakeWhatsAppSender(), payments: new FakePaymentProvider() });
  app = buildApp({ ...deps, env: { ...deps.env, JOBS_SECRET: 'jobs-secret' } });
});
afterEach(() => resetTenantsForTests());

const call = (secret?: string) =>
  app.request('/jobs/subscription-charges', { method: 'POST', headers: secret === undefined ? {} : { 'x-jobs-secret': secret } });

describe('POST /jobs/subscription-charges', () => {
  it('401 without or with a wrong secret', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('nope')).status).toBe(401);
  });

  it('runs the charge job for every tenant with the right secret', async () => {
    const res = await call('jobs-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenants: 1, raised: 0, skipped: 0, failed: 0 });
  });

  it('401 when JOBS_SECRET is not configured', async () => {
    const db = await createTestDb();
    const bare = buildApp(testDeps({ db }));
    const res = await bare.request('/jobs/subscription-charges', { method: 'POST', headers: { 'x-jobs-secret': '' } });
    expect(res.status).toBe(401);
  });
});
