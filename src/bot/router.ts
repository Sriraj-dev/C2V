import { errInfo } from './log.js';
import { textMsg } from '../channels/whatsapp/builders.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { upsertCustomer, type Customer } from '../customers/customer-repo.js';
import type { AppDeps } from '../deps.js';
import { recordInbound } from '../messages/message-store.js';
import type { TenantConfig } from '../tenants/types.js';
import {
  onLocationShared,
  onOrderFlowSubmit,
  onSubscribeFlowSubmit,
  sendMyOrders,
  sendOrderFlow,
  sendSubscribeFlow,
} from './handlers.js';
import { BTN_HELP, BTN_MY_ORDERS, BTN_ORDER, BTN_SUBSCRIBE, sendHelp, sendMenu } from './menu.js';

export { BTN_HELP, BTN_MY_ORDERS, BTN_ORDER, BTN_SUBSCRIBE };

async function dispatch(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  msg: InboundMessage,
): Promise<void> {
  if (msg.kind === 'button') {
    switch (msg.replyId) {
      case BTN_ORDER:
        return sendOrderFlow(deps, tenant, customer);
      case BTN_SUBSCRIBE:
        return sendSubscribeFlow(deps, tenant, customer);
      case BTN_MY_ORDERS:
        return sendMyOrders(deps, tenant, customer);
      case BTN_HELP:
        return sendHelp(deps, tenant, customer);
    }
  } else if (msg.kind === 'flow_submit') {
    if (msg.flowToken.startsWith('order:')) return onOrderFlowSubmit(deps, tenant, customer, msg);
    if (msg.flowToken.startsWith('subscribe:')) return onSubscribeFlowSubmit(deps, tenant, customer, msg);
  } else if (msg.kind === 'location') {
    return onLocationShared(deps, tenant, customer, msg);
  }
  return sendMenu(deps, tenant, customer);
}

/** Never throws: the webhook must always be acknowledged. */
export async function handleInbound(deps: AppDeps, tenant: TenantConfig, msg: InboundMessage): Promise<void> {
  const ids = { tenantId: tenant.id, waMessageId: msg.waMessageId, kind: msg.kind };
  let customer: Customer | undefined;
  try {
    customer = await upsertCustomer(deps.db, tenant.id, msg.from);
    if (!(await recordInbound(deps.db, tenant.id, customer.id, msg))) return;
    // Fire and forget: the typing indicator must not delay the reply.
    void Promise.resolve()
      .then(() => deps.whatsapp.markRead(tenant, msg.waMessageId, { typing: true }))
      .catch((err: unknown) => deps.log.warn({ ...ids, err: errInfo(err) }, 'markRead failed'));
    await dispatch(deps, tenant, customer, msg);
  } catch (err) {
    deps.log.error({ ...ids, err: errInfo(err) }, 'inbound dispatch failed');
    if (!customer) return;
    try {
      await sendAndLog(deps, tenant, customer, textMsg(tenant.copy.genericError()), tenant.copy.genericError());
    } catch (err2) {
      deps.log.error({ ...ids, err: errInfo(err2) }, 'generic error reply failed');
    }
  }
}
