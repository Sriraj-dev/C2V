import { flowMsg } from '../channels/whatsapp/builders.js';
import { encodeOrderFlowToken, orderFlowData } from '../channels/whatsapp/flows.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { listActiveProducts } from '../catalog/catalog-repo.js';
import type { Customer } from '../customers/customer-repo.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { errInfo } from './log.js';
import { sendMenu } from './menu.js';

/** Tapping "Order Eggs": send the order Flow prefilled with live products and the saved address. */
export async function sendOrderFlow(deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> {
  if (!tenant.flows.orderFlowId) {
    deps.log.warn({ tenantId: tenant.id }, 'orderFlowId not configured; sending menu instead');
    return sendMenu(deps, tenant, customer);
  }
  const products = await listActiveProducts(deps.db, tenant.id);
  if (products.length === 0) {
    deps.log.warn({ tenantId: tenant.id }, 'no active products; sending menu instead');
    return sendMenu(deps, tenant, customer);
  }
  let flowData: ReturnType<typeof orderFlowData>;
  try {
    const saved = customer.defaultAddress ?? null;
    // First-time customers: prefill the name from their WhatsApp profile.
    const prefill = saved ?? (customer.profileName ? { name: customer.profileName, line1: '', pincode: '' } : null);
    flowData = orderFlowData(products, prefill);
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, count: products.length, err: errInfo(err) }, 'cannot build order flow data; sending menu instead');
    return sendMenu(deps, tenant, customer);
  }
  const { data, slotMap } = flowData;
  const body = tenant.copy.orderFlowIntro();
  await sendAndLog(
    deps,
    tenant,
    customer,
    flowMsg({
      body,
      flowId: tenant.flows.orderFlowId,
      flowToken: encodeOrderFlowToken(customer.id, slotMap),
      cta: 'Order now',
      screen: 'PRODUCTS',
      data,
    }),
    body,
  );
}
