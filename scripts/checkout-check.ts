import { parseArgs } from 'node:util';
import { and, asc, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { startPayment } from '../src/orders/checkout.js';
import { listActiveProducts } from '../src/catalog/catalog-repo.js';
import { loadEnv } from '../src/config/env.js';
import { upsertCustomer, type Customer } from '../src/customers/customer-repo.js';
import { createDb, type Db } from '../src/db/client.js';
import { customers, pincodes } from '../src/db/schema.js';
import type { AppDeps } from '../src/deps.js';
import { nextDeliveryDate } from '../src/domain/delivery-date.js';
import { GraphWhatsAppSender } from '../src/channels/whatsapp/sender.js';
import { createOrder } from '../src/orders/order-service.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import type { TenantConfig } from '../src/tenants/types.js';
import { viaTestNumber } from './lib/meta-test-number.js';

/**
 * Dev tool: creates a payment_pending order for one phone and sends the real Pay button (real Cashfree link,
 * real WhatsApp send). Pay the link, and the running server's webhook confirms the order.
 *
 *   pnpm checkout:test --to 91XXXXXXXXXX [--via test|bot]
 *
 * --via test (default) sends from Meta's test number; the phone must have messaged that number in the last 24h.
 * The server receiving the Cashfree webhook must run with NUTRIFARM_WA_PHONE_NUMBER_ID=1444268992103737 so the
 * confirmation is also sent from the test number.
 */
const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    via: { type: 'string', default: 'test' },
  },
});
const to = values.to?.replace(/\D/g, '');
if (!to || to.length < 10 || !['test', 'bot'].includes(values.via!)) {
  console.error('Usage: pnpm checkout:test --to 91XXXXXXXXXX [--via test|bot]');
  process.exit(1);
}

const env = loadEnv(process.env);
const tenant: TenantConfig = values.via === 'test' ? viaTestNumber(nutrifarm, '') : nutrifarm;

async function customerFor(db: Db, phone: string): Promise<Customer> {
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, nutrifarm.id), eq(customers.waId, phone)))
    .limit(1);
  return existing ?? upsertCustomer(db, nutrifarm.id, { waId: phone, bsuid: null, profileName: null });
}

const deps: AppDeps = {
  env,
  now: () => new Date(),
  log: pino({ level: 'warn' }),
  db: createDb(env.DATABASE_URL),
  whatsapp: new GraphWhatsAppSender(env),
  payments: new CashfreeProvider(env),
};

const products = await listActiveProducts(deps.db, tenant.id);
if (products.length === 0) throw new Error('no active products; run db:seed first');
const [pin] = await deps.db
  .select()
  .from(pincodes)
  .where(and(eq(pincodes.tenantId, tenant.id), eq(pincodes.active, true)))
  .orderBy(asc(pincodes.pincode))
  .limit(1);
if (!pin) throw new Error('no active pincode; run db:seed first');

const first = products[0]!;
const last = products[products.length - 1]!;
const lines = [{ product: first, quantity: 2 }, ...(last.id !== first.id ? [{ product: last, quantity: 1 }] : [])];

const customer = await customerFor(deps.db, to);
const order = await createOrder(deps, tenant, customer, {
  lines,
  address: { name: 'Test Customer', line1: 'Test address', pincode: pin.pincode },
  location: customer.defaultLocation ?? null,
  status: 'payment_pending',
  source: 'one_time',
  deliveryDate: nextDeliveryDate(deps.now(), pin.deliveryWeekday),
});
await startPayment(deps, tenant, customer, order, products);

console.log(`Order ${order.orderCode} created; Pay button sent to ${to} via ${values.via} number (${tenant.waPhoneNumberId}).`);
console.log(`Link id: ${order.id}`);
console.log(`Notify URL: ${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/cashfree`);
console.log('Reminder: run the server with NUTRIFARM_WA_PHONE_NUMBER_ID=1444268992103737 so the confirmation is sent from the test number.');
process.exit(0);
