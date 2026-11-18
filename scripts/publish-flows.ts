import { parseArgs } from 'node:util';
import { buildOrderFlowJson, buildSubscribeFlowJson, createFlow, getFlowPreviewUrl, publishExistingFlow, updateFlowJson } from '../src/channels/whatsapp/flows.js';
import { loadEnv } from '../src/config/env.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { viaTestNumber } from './lib/meta-test-number.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

// Usage: pnpm flows:publish <tenantId> [--kind order|subscribe] [--name <name>] [--flow-id <draft id>]
// --kind picks the Flow (default order; names default to order_v1 / subscribe_v1).
// --flow-id publishes an already-created DRAFT instead of creating a new flow.
// --draft creates the flow without publishing; --test-number targets Meta's test WABA (dev previews).
// --update-json (requires --flow-id) uploads the current Flow JSON to that DRAFT without publishing it, then prints the preview URL.
// Only re-run when the Flow layout changes (never for product/price changes).
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: 'string', default: 'order' },
    name: { type: 'string' },
    'flow-id': { type: 'string' },
    draft: { type: 'boolean', default: false },
    'test-number': { type: 'boolean', default: false },
    'update-json': { type: 'boolean', default: false },
  },
});
if (values.kind !== 'order' && values.kind !== 'subscribe') {
  console.error('--kind must be order or subscribe');
  process.exit(1);
}
const kind = values.kind;
const name = values.name ?? `${kind}_v1`;
const buildJson = kind === 'subscribe' ? buildSubscribeFlowJson : buildOrderFlowJson;
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
if (values['update-json']) {
  if (!existing) {
    console.error('--update-json requires --flow-id <draft flow id>');
    process.exit(1);
  }
  await updateFlowJson(env, tenant, existing, buildJson());
  console.log(`Updated Flow JSON on draft flow ${existing} (not published)`);
  try {
    console.log(`Preview: ${await getFlowPreviewUrl(env, tenant, existing)}`);
  } catch (e) {
    console.error(`Updated, but preview url failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
if (existing) {
  await publishExistingFlow(env, tenant, existing);
  flowId = existing;
} else {
  flowId = await createFlow(env, tenant, name, buildJson(), { publish: !values.draft });
}
console.log(`${values.draft ? 'Created DRAFT' : 'Published'} flow for ${tenant.id}: flow id ${flowId}`);
console.log(
  kind === 'subscribe'
    ? `Set NUTRIFARM_SUBSCRIBE_FLOW_ID=${flowId}${values.draft ? ' and NUTRIFARM_SUBSCRIBE_FLOW_DRAFT=1' : ''} in .env (or the tenant config once published)`
    : `Paste into tenants/${tenant.id}/config.ts -> flows.orderFlowId`,
);
try {
  console.log(`Preview: ${await getFlowPreviewUrl(env, tenant, flowId)}`);
} catch (e) {
  console.error(`Published, but preview url failed: ${(e as Error).message}`);
}
