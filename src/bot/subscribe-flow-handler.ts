import { ctaUrlMsg, flowMsg, textMsg } from '../channels/whatsapp/builders.js';
import { decodeSubscribeFlowToken, encodeSubscribeFlowToken, orderFlowData } from '../channels/whatsapp/flows.js';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { findActivePincode, listActiveProducts } from '../catalog/catalog-repo.js';
import { saveDefaultAddress, saveEmail, type Customer } from '../customers/customer-repo.js';
import type { AppDeps } from '../deps.js';
import { firstSubscriptionDelivery, formatDeliveryDate, frequencyLabel, type Frequency } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { parseOrderSubmission } from '../orders/order-service.js';
import { normalizeIndianPhone } from '../payments/cashfree/client.js';
import { createSubscription } from '../subscriptions/subscription-service.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';
import { errInfo } from './log.js';
import { sendMenu } from './menu.js';

const FREQUENCIES: readonly Frequency[] = ['weekly', 'biweekly', 'monthly'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL = 254;

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

/**
 * Subscribe Flow submit: validate like a one-time order (+ frequency and email), save a pending subscription,
 * create the Cashfree mandate and reply with the summary and a "Set up AutoPay" button. Never logs PII.
 */
export async function onSubscribeFlowSubmit(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  msg: Extract<InboundMessage, { kind: 'flow_submit' }>,
): Promise<void> {
  const decoded = decodeSubscribeFlowToken(msg.flowToken);
  if (!decoded || decoded.customerId !== customer.id) {
    deps.log.warn({ tenantId: tenant.id }, 'subscribe flow token invalid or for another customer; sending menu');
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
  const frequency = FREQUENCIES.find((f) => f === msg.response.frequency);
  if (!frequency) return reply(deps, tenant, customer, copy.invalidAddress());
  const email = typeof msg.response.email === 'string' ? msg.response.email.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL) return reply(deps, tenant, customer, copy.invalidEmail());

  let address = parsed.address;
  let phone = customer.waId;
  if (!phone) {
    const asked = tryNormalizePhone(parsed.phone);
    if (!asked) return reply(deps, tenant, customer, copy.invalidPhone());
    address = { ...address, phone: asked };
    phone = asked;
  }
  const settings = await getTenantSettings(deps.db, tenant.id);
  const subtotal = parsed.lines.reduce((s, l) => s + l.product.pricePaise * l.quantity, 0);
  if (subtotal < settings.minOrderPaise) {
    return reply(deps, tenant, customer, copy.belowMinimum(formatPaise(settings.minOrderPaise)));
  }
  const pin = await findActivePincode(deps.db, tenant.id, address.pincode);
  if (!pin) return reply(deps, tenant, customer, copy.notServiceable(address.pincode));

  await saveDefaultAddress(deps.db, customer.id, address);
  await saveEmail(deps.db, customer.id, email);
  let created: Awaited<ReturnType<typeof createSubscription>>;
  try {
    created = await createSubscription(deps, tenant, customer, {
      lines: parsed.lines,
      address,
      location: customer.defaultLocation ?? null,
      frequency,
      deliveryWeekday: pin.deliveryWeekday,
      email,
      phone,
    });
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, customerId: customer.id, err: errInfo(err) }, 'subscription mandate creation failed');
    return reply(deps, tenant, customer, copy.genericError());
  }
  const body = copy.subscriptionSummary({
    lines: parsed.lines.map((l) => ({ name: l.product.name, qty: l.quantity, lineTotal: formatPaise(l.product.pricePaise * l.quantity) })),
    perDelivery: formatPaise(created.perDeliveryPaise),
    frequency: frequencyLabel(frequency, pin.deliveryWeekday),
    // Estimate: the real first date is fixed when AutoPay is approved (same rule, later clock).
    firstDelivery: formatDeliveryDate(firstSubscriptionDelivery(deps.now(), pin.deliveryWeekday)),
  });
  await sendAndLog(deps, tenant, customer, ctaUrlMsg({ body, buttonText: 'Set up AutoPay', url: created.authUrl }), body);
  deps.log.info({ tenantId: tenant.id, subscriptionId: created.subscription.id }, 'subscription pending authorisation');
}
