import { parseArgs } from 'node:util';
import { ensureTemplate, subscriptionTemplates } from '../src/channels/whatsapp/templates.js';
import { loadEnv } from '../src/config/env.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { viaTestNumber } from './lib/meta-test-number.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

// Usage: pnpm templates:create <tenantId> [--test-number]
// Creates the subscription templates if absent and prints each one's status. Safe to re-run.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'test-number': { type: 'boolean', default: false } },
});
const tenantId = positionals[0];
if (!tenantId) {
  console.error('Usage: pnpm templates:create <tenantId> [--test-number]');
  process.exit(1);
}
registerTenants([nutrifarm]);
const found = tenantById(tenantId);
if (!found) {
  console.error(`Unknown tenant: ${tenantId}`);
  process.exit(1);
}
const tenant = values['test-number'] ? viaTestNumber(found) : found;
console.log(`Target WABA: ${tenant.wabaId}${values['test-number'] ? ' (Meta test number account)' : ''}`);
const env = loadEnv(process.env);
for (const def of subscriptionTemplates()) {
  const r = await ensureTemplate(env, tenant, def);
  console.log(`${def.name} (${def.language}): ${r.created ? 'created, ' : 'exists, '}${r.status}`);
}
