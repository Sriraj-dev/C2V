import { parseArgs } from 'node:util';
import { buildOrderFlowJson, getFlowPreviewUrl, publishExistingFlow, publishFlow } from '../src/channels/whatsapp/flows.js';
import { loadEnv } from '../src/config/env.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';

// Usage: pnpm flows:publish <tenantId> [--name order_v1] [--flow-id <draft id>]
// --flow-id publishes an already-created DRAFT instead of creating a new flow.
// Only re-run when the Flow layout changes (never for product/price changes).
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string', default: 'order_v1' }, 'flow-id': { type: 'string' } },
});
const name = values.name;
const tenantId = positionals[0];
if (!tenantId || !name) {
  console.error('Usage: pnpm flows:publish <tenantId> [--name <flow name>]');
  process.exit(1);
}

registerTenants([nutrifarm]);
const tenant = tenantById(tenantId);
if (!tenant) {
  console.error(`Unknown tenant: ${tenantId}`);
  process.exit(1);
}

const env = loadEnv(process.env);
const existing = values['flow-id'];
let flowId: string;
if (existing) {
  await publishExistingFlow(env, tenant, existing);
  flowId = existing;
} else {
  flowId = await publishFlow(env, tenant, name, buildOrderFlowJson());
}
console.log(`Published flow for ${tenant.id}: flow id ${flowId}`);
console.log(`Paste into tenants/${tenant.id}/config.ts -> flows.orderFlowId`);
try {
  console.log(`Preview: ${await getFlowPreviewUrl(env, tenant, flowId)}`);
} catch (e) {
  console.error(`Published, but preview url failed: ${(e as Error).message}`);
}
