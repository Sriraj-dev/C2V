/**
 * Runs the daily subscription charge job once, locally (dev testing):
 *   pnpm jobs:run [--now 2026-11-21T09:00:00+05:30]
 * `--now` overrides the clock for picking due subscriptions; Cashfree still needs a charge date after the real today.
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { GraphWhatsAppSender } from '../src/channels/whatsapp/sender.js';
import { loadEnv } from '../src/config/env.js';
import { createDbHandle } from '../src/db/client.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { raiseDueCharges } from '../src/subscriptions/charges.js';
import { allTenants, registerTenants } from '../src/tenants/registry.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();
const { values } = parseArgs({ options: { now: { type: 'string' } } });
const now = values.now ? new Date(values.now) : new Date();
if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid date: ${values.now}`);

const env = loadEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });
registerTenants([nutrifarm]);
const { db, close } = createDbHandle(env.DATABASE_URL, log);
try {
  const deps = { env, now: () => now, log, db, whatsapp: new GraphWhatsAppSender(env), payments: new CashfreeProvider(env) };
  for (const tenant of allTenants()) console.log(tenant.id, await raiseDueCharges(deps, tenant));
} finally {
  await close();
}
