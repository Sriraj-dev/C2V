import { and, eq, inArray } from 'drizzle-orm';
import { templateMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { errInfo } from '../bot/log.js';
import { customers, deliveryPartners, orders, payments } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AppDeps } from '../deps.js';
import type { Payment } from '../payments/payment-repo.js';
import type { TenantConfig } from '../tenants/types.js';
import { findOrderById, type Order } from './order-repo.js';

export type TargetStatus = 'assigned' | 'out_for_delivery' | 'delivered' | 'cancelled';

/** Delivered-notification template as submitted to Meta (language `en`, one body param: the order code). */
export const DELIVERED_TEMPLATE = 'order_delivered';
export const DELIVERED_TEMPLATE_LANG = 'en';

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}

export class OrderNotFoundError extends Error {
  constructor() {
    super('Order not found');
    this.name = 'OrderNotFoundError';
  }
}

const TRANSITIONS: Record<string, readonly TargetStatus[]> = {
  confirmed: ['assigned', 'cancelled'],
  assigned: ['out_for_delivery', 'assigned', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
};

export interface UpdateStatusResult {
  order: Order;
  /**
   * Only meaningful for `delivered`: false when the delivered template could not be sent (the order is
   * still delivered). Always true for other transitions, which send nothing.
   */
  notified: boolean;
}

/**
 * Moves an order through the vendor lifecycle. Allowed: confirmed -> assigned|cancelled,
 * assigned -> out_for_delivery|assigned (reassign)|cancelled, out_for_delivery -> delivered|cancelled.
 * The write is a conditional UPDATE on the current status, so concurrent calls cannot both win.
 * `cancelled` never touches payments; a paid cancelled order needs an explicit `refundOrder`.
 * `delivered` stores status first, then sends the template; a send failure is logged, not thrown.
 */
export async function updateStatus(
  deps: AppDeps,
  tenant: TenantConfig,
  orderId: string,
  to: TargetStatus,
  opts: { partnerId?: string } = {},
): Promise<UpdateStatusResult> {
  const order = await findOrderById(deps.db, tenant.id, orderId);
  if (!order) throw new OrderNotFoundError();
  if (!TRANSITIONS[order.status]?.includes(to)) {
    throw new InvalidTransitionError(`Cannot move order ${order.orderCode} from ${order.status} to ${to}`);
  }

  const set: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: deps.now() };
  if (to === 'assigned') {
    if (!opts.partnerId) throw new Error('A delivery partner is required to assign an order');
    const [partner] = await deps.db
      .select()
      .from(deliveryPartners)
      .where(and(eq(deliveryPartners.tenantId, tenant.id), eq(deliveryPartners.id, opts.partnerId)))
      .limit(1);
    if (!partner) throw new Error('Delivery partner not found for this tenant');
    if (!partner.active) throw new Error(`Delivery partner ${partner.name} is not active`);
    set.assignedPartnerId = partner.id;
  }
  if (to === 'delivered') set.deliveredAt = deps.now();

  const rows = await deps.db
    .update(orders)
    .set(set)
    .where(and(eq(orders.id, order.id), eq(orders.tenantId, tenant.id), eq(orders.status, order.status)))
    .returning();
  if (rows.length === 0) {
    const fresh = await findOrderById(deps.db, tenant.id, order.id);
    throw new InvalidTransitionError(
      `Order ${order.orderCode} changed concurrently (now ${fresh?.status ?? 'missing'}); cannot move to ${to}`,
    );
  }
  const updated = rows[0]!;
  if (to !== 'delivered') return { order: updated, notified: true };

  const [customer] = await deps.db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenant.id), eq(customers.id, updated.customerId)))
    .limit(1);
  if (!customer) {
    deps.log.error({ tenantId: tenant.id, orderId: updated.id }, 'delivered order has no customer to notify');
    return { order: updated, notified: false };
  }
  try {
    await sendAndLog(
      deps,
      tenant,
      customer,
      templateMsg(DELIVERED_TEMPLATE, DELIVERED_TEMPLATE_LANG, [updated.orderCode]),
      `[template ${DELIVERED_TEMPLATE}] ${updated.orderCode}`,
    );
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, orderId: updated.id, err: errInfo(err) }, 'delivered template send failed');
    return { order: updated, notified: false };
  }
  return { order: updated, notified: true };
}

/** The order's payment-link payment, if any. */
export async function findLinkPayment(db: Db, tenantId: string, orderId: string): Promise<Payment | null> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.orderId, orderId), eq(payments.kind, 'link')))
    .limit(1);
  return row ?? null;
}

export type RefundResult = 'refunded' | 'already_refunded';

/** Fixed per order so retries are idempotent at Cashfree; `rf-` + uuid without dashes = 35 chars (Cashfree max 40). */
export function refundIdFor(orderId: string): string {
  return `rf-${orderId.replace(/-/g, '')}`;
}

const CANCEL_ON_REFUND = ['confirmed', 'assigned', 'out_for_delivery'] as const;

/**
 * Refunds a paid one-time order in full. Calls the provider first with the fixed id from `refundIdFor(orderId)`
 * (retries are idempotent at Cashfree); only on success marks the payment refunded and cancels the order
 * if it was still open (confirmed/assigned/out_for_delivery). Delivered/expired/cancelled keep their status.
 * Provider failure throws and leaves the DB unchanged. Sends no customer message.
 */
export async function refundOrder(deps: AppDeps, tenant: TenantConfig, orderId: string): Promise<RefundResult> {
  const order = await findOrderById(deps.db, tenant.id, orderId);
  if (!order) throw new OrderNotFoundError();
  if (order.source !== 'one_time') {
    throw new NotSupportedError('Refunds for subscription orders are not supported');
  }
  const payment = await findLinkPayment(deps.db, tenant.id, order.id);
  if (!payment) throw new Error(`Order ${order.orderCode} has no payment to refund`);
  if (payment.status === 'refunded') return 'already_refunded';
  if (payment.status !== 'paid') throw new Error(`Order ${order.orderCode} payment is ${payment.status}, not paid; nothing to refund`);

  await deps.payments.refundPaymentLink(tenant, payment.providerRef, payment.amountPaise, refundIdFor(order.id));

  try {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: 'refunded', updatedAt: deps.now() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'paid')));
      await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: deps.now() })
        .where(and(eq(orders.id, order.id), eq(orders.tenantId, tenant.id), inArray(orders.status, [...CANCEL_ON_REFUND])));
    });
  } catch (err) {
    deps.log.error(
      { tenantId: tenant.id, orderId: order.id, refundId: refundIdFor(order.id), err: errInfo(err) },
      'refund issued at provider but DB update failed; re-run refund',
    );
    throw new Error(`Refund was issued at the payment provider but the database update failed; re-run the refund for ${order.orderCode}`);
  }
  return 'refunded';
}
