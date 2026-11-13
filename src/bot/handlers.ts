import type { Customer } from '../customers/customer-repo.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { sendMenu } from './menu.js';

// Stubs: each is replaced by its owning task. Until then they show the menu.

export { onOrderFlowSubmit, sendOrderFlow } from './order-flow-handler.js';

/** Task 13 */
export const sendSubscribeFlow = (deps: AppDeps, tenant: TenantConfig, customer: Customer) =>
  sendMenu(deps, tenant, customer);

/** Task 12 */
export const sendMyOrders = (deps: AppDeps, tenant: TenantConfig, customer: Customer) =>
  sendMenu(deps, tenant, customer);

/** Task 13 */
export const onSubscribeFlowSubmit = (
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  _msg: Extract<InboundMessage, { kind: 'flow_submit' }>,
) => sendMenu(deps, tenant, customer);

/** Task 11 */
export const onLocationShared = (
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  _msg: Extract<InboundMessage, { kind: 'location' }>,
) => sendMenu(deps, tenant, customer);
