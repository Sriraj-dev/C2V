import { parseArgs } from 'node:util';
import { buildOrderFlowJson, createFlow, getFlowPreviewUrl, publishExistingFlow } from '../src/channels/whatsapp/flows.js';
import { loadEnv } from '../src/config/env.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { viaTestNumber } from './lib/meta-test-number.js';

// Usage: pnpm flows:publish <tenantId> [--name order_v1] [--flow-id <draft id>]
// --flow-id publishes an already-created DRAFT instead of creating a new flow.
// --draft creates the flow without publishing; --test-number targets Meta's test WABA (dev previews).
// Only re-run when the Flow layout changes (never for product/price changes).
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: 'order_v1' },
    'flow-id': { type: 'string' },
    draft: { type: 'boolean', default: false },
    'test-number': { type: 'boolean', default: false },
  },
});
const name = values.name;
const tenantId = positionals[0];
if (!tenantId || !name) {
  console.error('Usage: pnpm flows:publish <tenantId> [--name <flow name>]');
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
const existing = values['flow-id'];
let flowId: string;
if (existing) {
  await publishExistingFlow(env, tenant, existing);
  flowId = existing;
} else {
  flowId = await createFlow(env, tenant, name, buildOrderFlowJson(), { publish: !values.draft });
}
console.log(`${values.draft ? 'Created DRAFT' : 'Published'} flow for ${tenant.id}: flow id ${flowId}`);
console.log(`Paste into tenants/${tenant.id}/config.ts -> flows.orderFlowId`);
try {
  console.log(`Preview: ${await getFlowPreviewUrl(env, tenant, flowId)}`);
} catch (e) {
  console.error(`Published, but preview url failed: ${(e as Error).message}`);
}
