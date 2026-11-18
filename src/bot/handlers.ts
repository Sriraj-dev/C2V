import type { Customer } from '../customers/customer-repo.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { sendMenu } from './menu.js';

// Stubs: each is replaced by its owning task. Until then they show the menu.

export { onOrderFlowSubmit, sendOrderFlow } from './order-flow-handler.js';

export { sendSubscribeFlow } from './subscribe-flow-handler.js';

/** Replaced in subscriptions Task 4 (submit → pending subscription). */
export const onSubscribeFlowSubmit = (
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  _msg: Extract<InboundMessage, { kind: 'flow_submit' }>,
) => sendMenu(deps, tenant, customer);

export { onLocationShared } from './location.js';
