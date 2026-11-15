import type { Customer } from '../customers/customer-repo.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { textMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { sendMenu } from './menu.js';

// Stubs: each is replaced by its owning task. Until then they show the menu.

export { onOrderFlowSubmit, sendOrderFlow } from './order-flow-handler.js';

/** Subscriptions are on hold (Task 13): tell the customer the feature is coming soon. */
export const sendSubscribeFlow = async (deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> => {
  const text = tenant.copy.subscribeComingSoon();
  await sendAndLog(deps, tenant, customer, textMsg(text), text);
};

/** Task 13 */
export const onSubscribeFlowSubmit = (
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  _msg: Extract<InboundMessage, { kind: 'flow_submit' }>,
) => sendMenu(deps, tenant, customer);

export { onLocationShared } from './location.js';
