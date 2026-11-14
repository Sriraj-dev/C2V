import { and, eq } from 'drizzle-orm';
import { ctaUrlMsg, locationRequestMsg, textMsg, type OutboundMessage } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import type { Product } from '../catalog/catalog-repo.js';
import type { Customer } from '../customers/customer-repo.js';
import { customers, orders, payments } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { errInfo } from '../bot/log.js';
import { formatDeliveryDate } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { findPaymentByProviderRef, insertPayment } from '../payments/payment-repo.js';
import type { TenantConfig } from '../tenants/types.js';
import { findOrderById, type OrderWithItems } from './order-repo.js';

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

/** Summary with the Pay button, e.g. 'Pay ₹570' (cta_url button text is capped at 20 chars). */
export function orderSummaryWithPayButton(body: string, payUrl: string, totalPaise: number): OutboundMessage {
  return ctaUrlMsg({ body, buttonText: `Pay ${formatPaise(totalPaise)}`, url: payUrl });
}

const MS_PER_MINUTE = 60_000;

/**
 * Creates the Cashfree payment link for a payment_pending order, records a `payments` row and sends the
 * summary with the Pay button. If the link cannot be created the order stays pending and the customer
 * gets the generic error. Never logs PII.
 */
export async function startPayment(
  deps: AppDeps,
  tenant: TenantConfig,
  customer: Customer,
  order: OrderWithItems,
  products: Pick<Product, 'id' | 'name'>[] = [],
): Promise<void> {
  // BSUID-only customers have no waId; the order Flow collected a phone into the address.
  const customerPhone = customer.waId ?? order.address.phone;
  let link: { linkId: string; url: string };
  try {
    if (!customerPhone) throw new Error('no customer phone available for the payment link');
    link = await deps.payments.createPaymentLink(tenant, {
      linkId: order.id,
      amountPaise: order.totalPaise,
      purpose: `Order ${order.orderCode}`,
      customerPhone,
      customerName: order.address.name,
      expiresAt: new Date(deps.now().getTime() + tenant.paymentLinkExpiryMinutes * MS_PER_MINUTE),
      notifyUrl: `${deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/cashfree`,
    });
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, orderId: order.id, err: errInfo(err) }, 'payment link creation failed');
    const text = tenant.copy.genericError();
    await sendAndLog(deps, tenant, customer, textMsg(text), text);
    return;
  }
  await insertPayment(deps.db, {
    tenantId: tenant.id,
    orderId: order.id,
    kind: 'link',
    status: 'created',
    providerRef: link.linkId,
    amountPaise: order.totalPaise,
    linkUrl: link.url,
  });
  const body = buildOrderSummary(tenant, order, products);
  await sendAndLog(deps, tenant, customer, orderSummaryWithPayButton(body, link.url, order.totalPaise), body);
}

export type ConfirmResult = 'confirmed' | 'already' | 'not_paid' | 'amount_mismatch' | 'paid_after_close';

const CLOSED_STATUSES = new Set<string>(['expired', 'cancelled', 'payment_failed']);

/**
 * Confirms an order once its payment link is verifiably PAID for the full amount. The status flip is a
 * conditional UPDATE (payment_pending -> confirmed), so concurrent or repeated webhooks confirm exactly once.
 * Messages are sent after commit; a failed send never undoes the confirmation.
 */
export async function confirmPaidOrder(deps: AppDeps, tenant: TenantConfig, linkId: string): Promise<ConfirmResult> {
  const payment = await findPaymentByProviderRef(deps.db, tenant.id, linkId);
  if (!payment?.orderId) {
    deps.log.warn({ tenantId: tenant.id }, 'confirmPaidOrder: no payment for link id');
    return 'not_paid';
  }
  const order = await findOrderById(deps.db, tenant.id, payment.orderId);
  if (!order) {
    deps.log.warn({ tenantId: tenant.id, paymentId: payment.id }, 'confirmPaidOrder: payment has no order');
    return 'not_paid';
  }
  if (CLOSED_STATUSES.has(order.status)) {
    // A payment that completes after we closed the order must not vanish silently: record it and flag a refund.
    const closedLink = await deps.payments.getPaymentLink(tenant, linkId);
    if (closedLink.status !== 'PAID') return 'already';
    await deps.db.update(payments).set({ status: 'paid', raw: closedLink }).where(eq(payments.id, payment.id));
    deps.log.error(
      { tenantId: tenant.id, orderId: order.id, paidPaise: closedLink.amountPaidPaise },
      'payment received for closed order; refund needed',
    );
    return 'paid_after_close';
  }
  if (order.status !== 'payment_pending') return 'already';

  const link = await deps.payments.getPaymentLink(tenant, linkId);
  if (link.status !== 'PAID') return 'not_paid';
  if (link.amountPaidPaise !== order.totalPaise) {
    deps.log.error(
      { tenantId: tenant.id, orderId: order.id, expectedPaise: order.totalPaise, paidPaise: link.amountPaidPaise },
      'paid amount does not match order total',
    );
    return 'amount_mismatch';
  }

  const flipped = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(orders)
      .set({ status: 'confirmed', paidAt: deps.now() })
      .where(and(eq(orders.id, order.id), eq(orders.status, 'payment_pending')))
      .returning({ id: orders.id });
    if (rows.length === 0) return false;
    await tx.update(payments).set({ status: 'paid', raw: link }).where(eq(payments.id, payment.id));
    return true;
  });
  if (!flipped) return 'already';

  const [customer] = await deps.db.select().from(customers).where(and(eq(customers.tenantId, tenant.id), eq(customers.id, order.customerId))).limit(1);
  if (!customer) {
    deps.log.error({ tenantId: tenant.id, orderId: order.id }, 'confirmed order has no customer to notify');
    return 'confirmed';
  }
  const text = tenant.copy.orderConfirmed({ orderCode: order.orderCode, deliveryDate: formatDeliveryDate(order.deliveryDate) });
  try {
    await sendAndLog(deps, tenant, customer, textMsg(text), text);
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, orderId: order.id, err: errInfo(err) }, 'order confirmation send failed');
  }
  if (!customer.defaultLocation) {
    const ask = tenant.copy.askLocation();
    try {
      await sendAndLog(deps, tenant, customer, locationRequestMsg(ask), ask);
    } catch (err) {
      deps.log.error({ tenantId: tenant.id, orderId: order.id, err: errInfo(err) }, 'location request send failed');
    }
  }
  return 'confirmed';
}
