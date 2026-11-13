import { ctaUrlMsg, flowMsg, textMsg, type OutboundMessage } from '../channels/whatsapp/builders.js';
import { decodeOrderFlowToken, encodeOrderFlowToken, orderFlowData } from '../channels/whatsapp/flows.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { findActivePincode, listActiveProducts, type Product } from '../catalog/catalog-repo.js';
import { saveDefaultAddress, type Customer } from '../customers/customer-repo.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import { formatDeliveryDate, nextDeliveryDate } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { createOrder, parseOrderSubmission } from '../orders/order-service.js';
import type { OrderWithItems } from '../orders/order-repo.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
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

/** Pure: the order summary body text (lines, total, delivery date) from the tenant copy. */
export function buildOrderSummary(tenant: TenantConfig, order: OrderWithItems, products: Pick<Product, 'id' | 'name'>[] = []): string {
  const names = new Map(products.map((p) => [p.id, p.name]));
  return tenant.copy.orderSummary({
    orderCode: order.orderCode,
    lines: order.items.map((i) => ({
      name: names.get(i.productId) ?? i.name,
      qty: i.quantity,
      lineTotal: formatPaise(i.lineTotalPaise),
    })),
    total: formatPaise(order.totalPaise),
    deliveryDate: formatDeliveryDate(order.deliveryDate),
  });
}

/** Summary with the Pay button (used by Task 11's startPayment). */
export function orderSummaryWithPayButton(body: string, payUrl: string): OutboundMessage {
  return ctaUrlMsg({ body, buttonText: 'Pay now', url: payUrl });
}

async function reply(deps: AppDeps, tenant: TenantConfig, customer: Customer, text: string): Promise<void> {
  await sendAndLog(deps, tenant, customer, textMsg(text), text);
}

/** Flow submit: validate, create a payment_pending order, reply with the summary. Never logs PII. */
export async function onOrderFlowSubmit(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  msg: Extract<InboundMessage, { kind: 'flow_submit' }>,
): Promise<void> {
  const decoded = decodeOrderFlowToken(msg.flowToken);
  if (!decoded || decoded.customerId !== customer.id) {
    deps.log.warn({ tenantId: tenant.id }, 'order flow token invalid or for another customer; sending menu');
    return sendMenu(deps, tenant, customer);
  }
  const { copy } = tenant;
  const products = await listActiveProducts(deps.db, tenant.id);
  const parsed = parseOrderSubmission(msg.response, decoded.slotMap, products);
  if ('error' in parsed) {
    if (parsed.error === 'no_items') return reply(deps, tenant, customer, copy.noItems());
    if (parsed.error === 'invalid_pincode') return reply(deps, tenant, customer, copy.invalidPincode(parsed.raw));
    return reply(deps, tenant, customer, copy.invalidAddress());
  }
  const settings = await getTenantSettings(deps.db, tenant.id);
  const subtotal = parsed.lines.reduce((s, l) => s + l.product.pricePaise * l.quantity, 0);
  if (subtotal < settings.minOrderPaise) {
    return reply(deps, tenant, customer, copy.belowMinimum(formatPaise(settings.minOrderPaise)));
  }
  const pin = await findActivePincode(deps.db, tenant.id, parsed.address.pincode);
  if (!pin) return reply(deps, tenant, customer, copy.notServiceable(parsed.address.pincode));

  await saveDefaultAddress(deps.db, customer.id, parsed.address);
  const order = await createOrder(deps, tenant, customer, {
    lines: parsed.lines,
    address: parsed.address,
    location: customer.defaultLocation ?? null,
    status: 'payment_pending',
    source: 'one_time',
    deliveryDate: nextDeliveryDate(deps.now(), pin.deliveryWeekday),
  });
  // Task 11: replace with startPayment (cta_url Pay button)
  await reply(deps, tenant, customer, buildOrderSummary(tenant, order, products));
}
