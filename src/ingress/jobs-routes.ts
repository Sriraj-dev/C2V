import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { errInfo } from '../bot/log.js';
import type { AppDeps } from '../deps.js';
import { raiseDueCharges } from '../subscriptions/charges.js';
import { allTenants } from '../tenants/registry.js';

function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scheduled jobs, called by Cloud Scheduler with the shared `x-jobs-secret` header. */
export function jobsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // Daily at 09:00 IST (spec §10 "Charging"); safe to re-run.
  app.post('/jobs/subscription-charges', async (c) => {
    if (!secretMatches(c.req.header('x-jobs-secret'), deps.env.JOBS_SECRET)) return c.text('unauthorized', 401);
    const total = { tenants: 0, raised: 0, skipped: 0, failed: 0 };
    for (const tenant of allTenants()) {
      try {
        const r = await raiseDueCharges(deps, tenant);
        total.tenants++;
        total.raised += r.raised;
        total.skipped += r.skipped;
        total.failed += r.failed;
      } catch (err) {
        deps.log.error({ tenantId: tenant.id, err: errInfo(err) }, 'subscription charge run failed');
        total.failed++;
      }
    }
    return c.json(total);
  });

  return app;
}
