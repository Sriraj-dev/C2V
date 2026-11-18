import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import { errInfo } from '../bot/log.js';
import { templateMsg } from '../channels/whatsapp/builders.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import { SUBSCRIPTION_TEMPLATE_LANG, UPCOMING_CHARGE_TEMPLATE } from '../channels/whatsapp/templates.js';
import type { Db } from '../db/client.js';
import { customers, orderItems, orders, payments, products, subscriptionItems, subscriptions, type ChargeItem, type SubscriptionRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { addDays, formatDeliveryDate, frequencyStepDays, istToday } from '../domain/delivery-date.js';
import { formatPaise } from '../domain/money.js';
import { createOrder } from '../orders/order-service.js';
import type { TenantConfig } from '../tenants/types.js';

/** Attempts per Cashfree call within one run, and the waits between them (spec §10 "Charging"). */
const RETRY_DELAYS_MS = [5_000, 30_000];

export type ChargeOutcome = 'raised' | 'already' | 'skipped' | 'failed' | 'not_due';
export interface ChargeRunResult {
  raised: number;
  skipped: number;
  failed: number;
}
export interface ChargeOpts {
  /** Waits between Cashfree retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * The daily charge run (spec §10 "Charging"): every active subscription whose next delivery D is within
 * `subscriptionChargeLeadDays` gets its upcoming order, a charge and the upcoming-charge message. Safe to re-run.
 */
export async function raiseDueCharges(deps: AppDeps, tenant: TenantConfig, opts: ChargeOpts = {}): Promise<ChargeRunResult> {
  const horizon = addDays(istToday(deps.now()), tenant.subscriptionChargeLeadDays);
  const due = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenantId, tenant.id), eq(subscriptions.status, 'active'), lte(subscriptions.nextDeliveryDate, horizon)));
  const result: ChargeRunResult = { raised: 0, skipped: 0, failed: 0 };
  for (const sub of due) {
    let outcome: ChargeOutcome;
    try {
      outcome = await raiseNextCharge(deps, tenant, sub, opts);
    } catch (err) {
      deps.log.error({ tenantId: tenant.id, subscriptionId: sub.id, err: errInfo(err) }, 'subscription charge failed');
      outcome = 'failed';
    }
    if (outcome === 'raised') result.raised++;
    else if (outcome === 'skipped') result.skipped++;
    else if (outcome === 'failed') result.failed++;
  }
  deps.log.info({ tenantId: tenant.id, ...result }, 'subscription charge run done');
  return result;
}

/**
 * Raises the charge for one subscription's next delivery D if it is due. Also called at activation, so a mandate
 * approved after the day's run is charged straight away. Order of work: re-fetch Cashfree status, build items at
 * current prices, create order + payment together, raise the charge (D-1, or D when D-1 is today), advance the
 * date, send the template. A failed raise leaves nothing behind and the date unchanged, so the next run retries.
 */
export async function raiseNextCharge(
  deps: AppDeps,
  tenant: TenantConfig,
  sub: SubscriptionRow,
  opts: ChargeOpts = {},
): Promise<ChargeOutcome> {
  const sleep = opts.sleep ?? defaultSleep;
  const today = istToday(deps.now());
  const d = sub.nextDeliveryDate;
  const log = { tenantId: tenant.id, subscriptionId: sub.id, deliveryDate: d };
  if (sub.status !== 'active' || !d || d > addDays(today, tenant.subscriptionChargeLeadDays)) return 'not_due';

  if (d <= today) {
    // Too late to charge ahead of delivery: skip this cycle, never charge on the day.
    await advance(deps.db, sub, d, nextAfter(sub, d, today));
    deps.log.warn(log, 'subscription cycle skipped: delivery date already reached');
    return 'skipped';
  }

  const [existing] = await deps.db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.subscriptionId, sub.id), eq(payments.forDeliveryDate, d)))
    .limit(1);
  if (existing) {
    // Raised by an earlier run that stopped before moving the date on.
    await advance(deps.db, sub, d, addDays(d, frequencyStepDays(sub.frequency)));
    return 'already';
  }

  const remote = await withRetry(() => deps.payments.getSubscription(tenant, sub.id), sleep);
  if (remote.status === 'CUSTOMER_PAUSED') {
    await advance(deps.db, sub, d, addDays(d, frequencyStepDays(sub.frequency)));
    deps.log.info(log, 'subscription cycle skipped: paused by customer');
    return 'skipped';
  }
  if (remote.status !== 'ACTIVE') {
    // Ended or in-between: the status webhook settles the local state; nothing is charged.
    deps.log.warn({ ...log, remoteStatus: remote.status }, 'subscription not active at Cashfree; no charge');
    return 'skipped';
  }

  const lines = await currentLines(deps.db, tenant.id, sub.id);
  if (lines.length === 0) {
    await advance(deps.db, sub, d, addDays(d, frequencyStepDays(sub.frequency)));
    deps.log.warn(log, 'subscription cycle skipped: no active products left');
    return 'skipped';
  }

  const [customer] = await deps.db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1);
  if (!customer) throw new Error('subscription customer not found');

  const paymentId = randomUUID();
  let created: { orderId: string; amountPaise: number };
  try {
    created = await deps.db.transaction(async (tx) => {
      const order = await createOrder({ db: tx }, tenant, customer, {
        lines,
        address: sub.address,
        location: sub.location,
        status: 'payment_pending',
        source: 'subscription',
        subscriptionId: sub.id,
        deliveryDate: d,
      });
      const chargeItems: ChargeItem[] = lines.map((l) => ({ productId: l.product.id, name: l.product.name, unitPricePaise: l.product.pricePaise, quantity: l.quantity }));
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.id,
        orderId: order.id,
        subscriptionId: sub.id,
        forDeliveryDate: d,
        chargeItems,
        kind: 'subscription_charge',
        providerRef: paymentId,
        amountPaise: order.totalPaise,
        status: 'created',
      });
      return { orderId: order.id, amountPaise: order.totalPaise };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'already'; // a concurrent run got there first
    throw err;
  }

  const chargeDay = addDays(d, -1) > today ? addDays(d, -1) : d;
  try {
    await withRetry(
      () => deps.payments.raiseCharge(tenant, { subscriptionId: sub.id, paymentId, amountPaise: created.amountPaise, scheduleDate: chargeDay }),
      sleep,
    );
  } catch (err) {
    // The raise may have reached Cashfree even though we saw an error; a charge that exists must be kept.
    const exists = await deps.payments.getCharge(tenant, sub.id, paymentId).then(() => true, () => false);
    if (!exists) {
      await removeUnraised(deps.db, paymentId, created.orderId);
      deps.log.error({ ...log, err: errInfo(err) }, 'subscription charge raise failed; will retry next run');
      return 'failed';
    }
  }

  await advance(deps.db, sub, d, addDays(d, frequencyStepDays(sub.frequency)));
  deps.log.info({ ...log, paymentId, chargeDay }, 'subscription charge raised');

  const amount = formatPaise(created.amountPaise).replace('₹', '');
  const msg = templateMsg(UPCOMING_CHARGE_TEMPLATE, SUBSCRIPTION_TEMPLATE_LANG, [amount, formatDeliveryDate(d)], {
    quickReplyPayloads: [`skip:${paymentId}`],
  });
  try {
    await sendAndLog(deps, tenant, customer, msg, `Upcoming charge ₹${amount} for ${formatDeliveryDate(d)}`);
  } catch (err) {
    deps.log.error({ ...log, err: errInfo(err) }, 'upcoming charge message failed');
  }
  return 'raised';
}

/** The first delivery after `today` on this subscription's cadence, starting from a missed date. */
function nextAfter(sub: SubscriptionRow, from: string, today: string): string {
  let next = from;
  while (next <= today) next = addDays(next, frequencyStepDays(sub.frequency));
  return next;
}

/** Moves next_delivery_date from `from` to `to`, only if it is still `from` (repeat runs move it once). */
async function advance(db: Db, sub: SubscriptionRow, from: string, to: string): Promise<void> {
  await db
    .update(subscriptions)
    .set({ nextDeliveryDate: to })
    .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.nextDeliveryDate, from)));
}

/** Subscription items for products still active, at current prices; removed products are dropped. */
async function currentLines(db: Db, tenantId: string, subscriptionId: string) {
  const rows = await db
    .select({ product: products, quantity: subscriptionItems.quantity })
    .from(subscriptionItems)
    .innerJoin(products, eq(products.id, subscriptionItems.productId))
    .where(and(eq(subscriptionItems.subscriptionId, subscriptionId), eq(products.tenantId, tenantId), eq(products.active, true)));
  return rows;
}

async function removeUnraised(db: Db, paymentId: string, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(payments).where(eq(payments.id, paymentId));
    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await tx.delete(orders).where(eq(orders.id, orderId));
  });
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === 'object' && i < 5; i++, e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
