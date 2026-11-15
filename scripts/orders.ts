import { pino } from 'pino';
import { and, eq } from 'drizzle-orm';
import { GraphWhatsAppSender } from '../src/channels/whatsapp/sender.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { deliveryPartners } from '../src/db/schema.js';
import type { AppDeps } from '../src/deps.js';
import { findOrderByCode } from '../src/orders/order-repo.js';
import { findLinkPayment, refundOrder, updateStatus } from '../src/orders/order-status.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

/**
 * Ops tool for vendor order operations (same service functions the Phase 2 dashboard will call).
 *
 *   pnpm orders <tenantId> <orderCode> assign <partnerPhone> | out-for-delivery | delivered | cancel | refund
 */
const USAGE = 'Usage: pnpm orders <tenantId> <orderCode> assign <partnerPhone> | out-for-delivery | delivered | cancel | refund';
const [tenantId, orderCode, action, arg] = process.argv.slice(2);
const needsArg = action === 'assign';
if (!tenantId || !orderCode || !['assign', 'out-for-delivery', 'delivered', 'cancel', 'refund'].includes(action ?? '') || (needsArg && !arg)) {
  console.error(USAGE);
  process.exit(1);
}

try {
  registerTenants([nutrifarm]);
  const tenant = tenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
  const env = loadEnv(process.env);
  const deps: AppDeps = {
    env,
    now: () => new Date(),
    log: pino({ level: 'warn' }),
    db: createDb(env.DATABASE_URL),
    whatsapp: new GraphWhatsAppSender(env),
    payments: new CashfreeProvider(env),
  };
  const order = await findOrderByCode(deps.db, tenant.id, orderCode);
  if (!order) throw new Error(`Order ${orderCode} not found for tenant ${tenant.id}`);

  if (action === 'assign') {
    let phone = arg!.replace(/\D/g, '');
    if (phone.length === 10) phone = `91${phone}`;
    const [partner] = await deps.db
      .select()
      .from(deliveryPartners)
      .where(and(eq(deliveryPartners.tenantId, tenant.id), eq(deliveryPartners.phone, phone), eq(deliveryPartners.active, true)))
      .limit(1);
    if (!partner) throw new Error(`No active delivery partner with phone ${phone} for tenant ${tenant.id}`);
    const r = await updateStatus(deps, tenant, order.id, 'assigned', { partnerId: partner.id });
    console.log(`${orderCode}: ${r.order.status} to ${partner.name}`);
  } else if (action === 'out-for-delivery') {
    const r = await updateStatus(deps, tenant, order.id, 'out_for_delivery');
    console.log(`${orderCode}: ${r.order.status}`);
  } else if (action === 'delivered') {
    const r = await updateStatus(deps, tenant, order.id, 'delivered');
    console.log(`${orderCode}: ${r.order.status}`);
    if (!r.notified) console.warn('WARNING: order is delivered but the customer notification was not sent (see logs)');
  } else if (action === 'cancel') {
    const r = await updateStatus(deps, tenant, order.id, 'cancelled');
    console.log(`${orderCode}: ${r.order.status}`);
    const p = await findLinkPayment(deps.db, tenant.id, order.id);
    if (p?.status === 'paid') console.log(`Payment was received: run "pnpm orders ${tenant.id} ${orderCode} refund" to refund it.`);
  } else {
    const r = await refundOrder(deps, tenant, order.id);
    console.log(`${orderCode}: ${r === 'refunded' ? 'refunded' : 'already refunded'}`);
    if (r === 'refunded' && order.status === 'out_for_delivery') {
      console.log('Order was out for delivery and is now cancelled: inform the delivery partner.');
    }
  }
  process.exit(0);
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
