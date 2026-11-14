import { flowMsg, textMsg } from '../channels/whatsapp/builders.js';
import { decodeOrderFlowToken, encodeOrderFlowToken, orderFlowData } from '../channels/whatsapp/flows.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { findActivePincode, listActiveProducts, type Product } from '../catalog/catalog-repo.js';
import { saveDefaultAddress, type Customer } from '../customers/customer-repo.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import { nextDeliveryDate } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { normalizeIndianPhone } from '../payments/cashfree/client.js';
import { buildOrderSummary, orderSummaryWithPayButton, startPayment } from '../orders/checkout.js';
import { createOrder, parseOrderSubmission } from '../orders/order-service.js';
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
    flowData = orderFlowData(products, prefill, { askPhone: !customer.waId });
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

export { buildOrderSummary, orderSummaryWithPayButton };

async function reply(deps: AppDeps, tenant: TenantConfig, customer: Customer, text: string): Promise<void> {
  await sendAndLog(deps, tenant, customer, textMsg(text), text);
}

function tryNormalizePhone(raw: string): string | null {
  try {
    return normalizeIndianPhone(raw);
  } catch {
    return null;
  }
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
  // Customers without a WhatsApp phone (BSUID-only) must give a valid mobile number for the payment link.
  let address = parsed.address;
  if (!customer.waId) {
    const phone = tryNormalizePhone(parsed.phone);
    if (!phone) return reply(deps, tenant, customer, copy.invalidPhone());
    address = { ...address, phone };
  }
  const settings = await getTenantSettings(deps.db, tenant.id);
  const subtotal = parsed.lines.reduce((s, l) => s + l.product.pricePaise * l.quantity, 0);
  if (subtotal < settings.minOrderPaise) {
    return reply(deps, tenant, customer, copy.belowMinimum(formatPaise(settings.minOrderPaise)));
  }
  const pin = await findActivePincode(deps.db, tenant.id, address.pincode);
  if (!pin) return reply(deps, tenant, customer, copy.notServiceable(address.pincode));

  await saveDefaultAddress(deps.db, customer.id, address);
  const order = await createOrder(deps, tenant, customer, {
    lines: parsed.lines,
    address,
    location: customer.defaultLocation ?? null,
    status: 'payment_pending',
    source: 'one_time',
    deliveryDate: nextDeliveryDate(deps.now(), pin.deliveryWeekday),
  });
  await startPayment(deps, tenant, customer, order, products);
}
