import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { errInfo } from '../bot/log.js';
import { sendMenu } from '../bot/menu.js';
import { templateMsg, textMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { CHARGE_FAILED_TEMPLATE, SUBSCRIPTION_TEMPLATE_LANG } from '../channels/whatsapp/templates.js';
import type { Customer } from '../customers/customer-repo.js';
import { customers, orders, payments, subscriptions, type PaymentRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { addDays, formatDeliveryDate, frequencyStepDays } from '../domain/delivery-date.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';

export type ChargeResult = 'confirmed' | 'failed' | 'cancelled' | 'unchanged';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Order states that mean the delivery is paid for and going ahead. */
const PAID_ORDER_STATUSES = new Set(['confirmed', 'assigned', 'out_for_delivery', 'delivered']);

async function findCharge(deps: AppDeps, tenant: TenantConfig, paymentId: string): Promise<PaymentRow | null> {
  if (!UUID_RE.test(paymentId)) return null;
  const [p] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.providerRef, paymentId), eq(payments.tenantId, tenant.id), eq(payments.kind, 'subscription_charge')))
    .limit(1);
  return p ?? null;
}

/**
 * Settles a subscription charge from Cashfree's own record (the webhook body is never trusted). Conditional
 * updates make repeats no-ops. Success confirms the upcoming order without a message (spec §10 "Charge result");
 * a final failure marks it payment_failed and sends `subscription_charge_failed`.
 */
export async function onChargeResult(deps: AppDeps, tenant: TenantConfig, subscriptionId: string, paymentId: string): Promise<ChargeResult> {
  const payment = await findCharge(deps, tenant, paymentId);
  if (!payment || payment.subscriptionId !== subscriptionId) return 'unchanged';
  const { status } = await deps.payments.getCharge(tenant, subscriptionId, paymentId);
  return applyChargeStatus(deps, tenant, payment, status);
}

async function applyChargeStatus(deps: AppDeps, tenant: TenantConfig, payment: PaymentRow, status: string): Promise<ChargeResult> {
  const log = { tenantId: tenant.id, paymentId: payment.id, orderId: payment.orderId };
  if (status === 'SUCCESS') {
    const now = deps.now();
    const outcome = await deps.db.transaction(async (tx) => {
      const paid = await tx
        .update(payments)
        .set({ status: 'paid', updatedAt: now })
        .where(and(eq(payments.id, payment.id), notInArray(payments.status, ['paid', 'refunded'])))
        .returning({ id: payments.id });
      if (paid.length === 0 || !payment.orderId) return 'unchanged' as const;
      const confirmed = await tx
        .update(orders)
        .set({ status: 'confirmed', paidAt: now, updatedAt: now })
        .where(and(eq(orders.id, payment.orderId), inArray(orders.status, ['payment_pending', 'payment_failed'])))
        .returning({ id: orders.id });
      return confirmed.length ? ('confirmed' as const) : ('paid_after_close' as const);
    });
    if (outcome === 'paid_after_close') {
      deps.log.error(log, 'subscription charge collected for a closed order; refund needed');
      return 'unchanged';
    }
    if (outcome === 'confirmed') deps.log.info(log, 'subscription order confirmed');
    return outcome;
  }

  if (status === 'FAILED') {
    const changed = await deps.db.transaction(async (tx) => {
      const failed = await tx
        .update(payments)
        .set({ status: 'failed', updatedAt: deps.now() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'created')))
        .returning({ id: payments.id });
      if (failed.length === 0) return false;
      if (payment.orderId) {
        await tx
          .update(orders)
          .set({ status: 'payment_failed', updatedAt: deps.now() })
          .where(and(eq(orders.id, payment.orderId), eq(orders.status, 'payment_pending')));
      }
      return true;
    });
    if (!changed) return 'unchanged';
    deps.log.info(log, 'subscription charge failed');
    await notifyFailed(deps, tenant, payment);
    return 'failed';
  }

  if (status === 'CANCELLED') return (await markCancelled(deps, payment)) ? 'cancelled' : 'unchanged';
  return 'unchanged';
}

/** Payment created/failed → cancelled, and its not-yet-paid order → cancelled. True if the payment changed. */
async function markCancelled(deps: AppDeps, payment: PaymentRow): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(payments)
      .set({ status: 'cancelled', updatedAt: deps.now() })
      .where(and(eq(payments.id, payment.id), inArray(payments.status, ['created', 'failed'])))
      .returning({ id: payments.id });
    if (rows.length === 0) return false;
    if (payment.orderId) {
      await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: deps.now() })
        .where(and(eq(orders.id, payment.orderId), inArray(orders.status, ['payment_pending', 'payment_failed'])));
    }
    return true;
  });
}

async function notifyFailed(deps: AppDeps, tenant: TenantConfig, payment: PaymentRow): Promise<void> {
  try {
    const [sub] = await deps.db.select({ customerId: subscriptions.customerId }).from(subscriptions).where(eq(subscriptions.id, payment.subscriptionId!)).limit(1);
    const [customer] = sub ? await deps.db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1) : [];
    if (!customer) return;
    const date = formatDeliveryDate(payment.forDeliveryDate!);
    await sendAndLog(deps, tenant, customer, templateMsg(CHARGE_FAILED_TEMPLATE, SUBSCRIPTION_TEMPLATE_LANG, [date]), `Charge failed for ${date}`);
  } catch (err) {
    deps.log.error({ tenantId: tenant.id, paymentId: payment.id, err: errInfo(err) }, 'charge failed message send failed');
  }
}

/**
 * The customer tapped *Skip this delivery* (payload `skip:<paymentId>`). Decided by Cashfree's cancel result and a
 * re-fetch, not only our DB, because the success webhook can lag (spec §10 "Skip").
 */
export async function skipCharge(deps: AppDeps, tenant: TenantConfig, customer: Customer, paymentId: string): Promise<void> {
  const payment = await findCharge(deps, tenant, paymentId);
  const [sub] = payment?.subscriptionId
    ? await deps.db.select().from(subscriptions).where(eq(subscriptions.id, payment.subscriptionId)).limit(1)
    : [];
  if (!payment || !sub || sub.customerId !== customer.id) return sendMenu(deps, tenant, customer);
  const [order] = payment.orderId ? await deps.db.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1) : [];
  const { supportPhone } = await getTenantSettings(deps.db, tenant.id);

  const d = payment.forDeliveryDate!;
  const reply = (text: string) => sendAndLog(deps, tenant, customer, textMsg(text), text);
  const done = () =>
    reply(tenant.copy.skipDone({ date: formatDeliveryDate(d), next: formatDeliveryDate(sub.nextDeliveryDate ?? addDays(d, frequencyStepDays(sub.frequency))) }));
  const alreadyPaid = () => reply(tenant.copy.skipAlreadyPaid({ orderCode: order?.orderCode ?? '-', supportPhone }));

  if (payment.status === 'cancelled') return void (await done());
  if (payment.status === 'paid' || payment.status === 'refunded' || (order && PAID_ORDER_STATUSES.has(order.status))) {
    return void (await alreadyPaid());
  }

  try {
    await deps.payments.cancelCharge(tenant, sub.id, payment.providerRef);
  } catch (err) {
    // A refusal is expected when the debit is in progress or done; the re-fetch below decides.
    deps.log.info({ tenantId: tenant.id, paymentId: payment.id, err: errInfo(err) }, 'skip: charge cancel refused');
  }
  const { status } = await deps.payments.getCharge(tenant, sub.id, payment.providerRef);
  if (status === 'CANCELLED' || status === 'FAILED') {
    await markCancelled(deps, payment);
    deps.log.info({ tenantId: tenant.id, paymentId: payment.id, remoteStatus: status }, 'subscription delivery skipped');
    return void (await done());
  }
  if (status === 'SUCCESS') {
    await applyChargeStatus(deps, tenant, payment, status);
    return void (await alreadyPaid());
  }
  await reply(tenant.copy.skipProcessing({ supportPhone }));
}
