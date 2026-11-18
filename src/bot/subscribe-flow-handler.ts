import { flowMsg, textMsg } from '../channels/whatsapp/builders.js';
import { encodeSubscribeFlowToken, orderFlowData } from '../channels/whatsapp/flows.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { listActiveProducts } from '../catalog/catalog-repo.js';
import type { Customer } from '../customers/customer-repo.js';
import type { AppDeps } from '../deps.js';
import type { TenantConfig } from '../tenants/types.js';
import { errInfo } from './log.js';
import { sendMenu } from './menu.js';

/** Tapping "Subscribe": send the subscribe Flow prefilled with live products, the saved address and email. */
export async function sendSubscribeFlow(deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> {
  if (!tenant.flows.subscribeFlowId) {
    const text = tenant.copy.subscribeComingSoon();
    await sendAndLog(deps, tenant, customer, textMsg(text), text);
    return;
  }
  const products = await listActiveProducts(deps.db, tenant.id);
  if (products.length === 0) {
    deps.log.warn({ tenantId: tenant.id }, 'no active products; sending menu instead');
    return sendMenu(deps, tenant, customer);
  }
  let flowData: ReturnType<typeof orderFlowData>;
  try {
    const saved = customer.defaultAddress ?? null;
    const prefill = saved ?? (customer.profileName ? { name: customer.profileName, line1: '', pincode: '' } : null);
    flowData = orderFlowData(products, prefill, { askPhone: !customer.waId });
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, count: products.length, err: errInfo(err) }, 'cannot build subscribe flow data; sending menu instead');
    return sendMenu(deps, tenant, customer);
  }
  const body = tenant.copy.subscribeFlowIntro();
  await sendAndLog(
    deps,
    tenant,
    customer,
    flowMsg({
      body,
      flowId: tenant.flows.subscribeFlowId,
      flowToken: encodeSubscribeFlowToken(customer.id, flowData.slotMap),
      cta: 'Subscribe',
      screen: 'PRODUCTS',
      data: { ...flowData.data, prefill_email: customer.email ?? '' },
      ...(tenant.flows.subscribeFlowDraft ? { mode: 'draft' as const } : {}),
    }),
    body,
  );
}
