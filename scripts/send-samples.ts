import { parseArgs } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { textMsg, type OutboundMessage } from '../src/channels/whatsapp/builders.js';
import { GraphWhatsAppSender, sendAndLog, type WhatsAppSender } from '../src/channels/whatsapp/sender.js';
import { sendHelp, sendMenu } from '../src/bot/menu.js';
import { buildOrderSummary, orderSummaryWithPayButton, sendOrderFlow } from '../src/bot/order-flow-handler.js';
import { listActiveProducts } from '../src/catalog/catalog-repo.js';
import { nextDeliveryDate } from '../src/domain/delivery-date.js';
import { formatPaise } from '../src/domain/money.js';
import { generateOrderCode } from '../src/domain/order-code.js';
import type { OrderWithItems } from '../src/orders/order-repo.js';
import { getTenantSettings } from '../src/tenants/settings-repo.js';
import { loadEnv } from '../src/config/env.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { upsertCustomer, type Customer } from '../src/customers/customer-repo.js';
import { createDb, type Db } from '../src/db/client.js';
import { customers } from '../src/db/schema.js';
import type { AppDeps } from '../src/deps.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import type { TenantConfig } from '../src/tenants/types.js';
import { viaTestNumber } from './lib/meta-test-number.js';

/**
 * Dev tool: sends the bot's real messages (same code paths as the live bot) to one phone so you can see
 * them as a customer would. Writes outbound rows to the dev DB like the bot does.
 *
 *   pnpm samples:send --to 91XXXXXXXXXX [--via test|bot] [--only menu,help,order,summary,no_items,bad_pincode,not_serviceable,below_min,error] [--flow-id <id>] [--draft]
 *
 * --via test (default) sends from Meta's test number; the phone must have messaged that number in the last
 *   24h (free-form messages need an open customer-service window).
 * --flow-id / --draft: the order Flow id on the sending WABA; --draft sends it in draft mode (unpublished Flow).
 */
const sendText = async (deps: AppDeps, t: TenantConfig, c: Customer, text: string) =>
  sendAndLog(deps, t, c, textMsg(text), text);

const SAMPLES: Record<string, (deps: AppDeps, t: TenantConfig, c: Customer) => Promise<void>> = {
  menu: sendMenu, // welcome image + list menu
  help: sendHelp, // "Call the farm" button
  order: sendOrderFlow, // order Flow (Order now)
  // In-memory order (nothing is written to the DB): 2x first product, 1x last product.
  summary: async (deps, t, c) => {
    const products = await listActiveProducts(deps.db, t.id);
    if (products.length === 0) throw new Error('no active products to build a summary from');
    const settings = await getTenantSettings(deps.db, t.id);
    const picks = [
      { p: products[0]!, q: 2 },
      { p: products[products.length - 1]!, q: 1 },
    ];
    const now = deps.now();
    const subtotal = picks.reduce((s, x) => s + x.p.pricePaise * x.q, 0);
    const order = {
      id: 'preview',
      tenantId: t.id,
      orderCode: generateOrderCode(t.orderCodePrefix),
      deliveryDate: nextDeliveryDate(now, 3),
      subtotalPaise: subtotal,
      deliveryFeePaise: settings.deliveryFeePaise,
      totalPaise: subtotal + settings.deliveryFeePaise,
      items: picks.map((x) => ({
        id: 'preview',
        orderId: 'preview',
        productId: x.p.id,
        name: x.p.name,
        unitPricePaise: x.p.pricePaise,
        quantity: x.q,
        lineTotalPaise: x.p.pricePaise * x.q,
        createdAt: now,
      })),
    } as unknown as OrderWithItems;
    const body = buildOrderSummary(t, order, products);
    await sendAndLog(deps, t, c, orderSummaryWithPayButton(body, 'https://payments.cashfree.com/links/preview'), body);
  },
  no_items: (deps, t, c) => sendText(deps, t, c, t.copy.noItems()),
  bad_pincode: (deps, t, c) => sendText(deps, t, c, t.copy.invalidPincode('56003')),
  not_serviceable: (deps, t, c) => sendText(deps, t, c, t.copy.notServiceable('110001')),
  below_min: async (deps, t, c) => {
    const settings = await getTenantSettings(deps.db, t.id);
    await sendText(deps, t, c, t.copy.belowMinimum(formatPaise(settings.minOrderPaise > 0 ? settings.minOrderPaise : 10000)));
  },
  error: async (deps, t, c) => {
    const text = t.copy.genericError();
    await sendAndLog(deps, t, c, textMsg(text), text);
  },
};

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    via: { type: 'string', default: 'test' },
    only: { type: 'string', default: Object.keys(SAMPLES).join(',') },
    'flow-id': { type: 'string' },
    draft: { type: 'boolean', default: false },
  },
});
const to = values.to?.replace(/\D/g, '');
const names = values.only!.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = names.filter((n) => !SAMPLES[n]);
if (!to || to.length < 10 || unknown.length || !['test', 'bot'].includes(values.via!)) {
  console.error(
    `Usage: pnpm samples:send --to 91XXXXXXXXXX [--via test|bot] [--only ${Object.keys(SAMPLES).join(',')}] [--flow-id <id>] [--draft]` +
      (unknown.length ? `\nUnknown sample(s): ${unknown.join(', ')}` : ''),
  );
  process.exit(1);
}

const env = loadEnv(process.env);
let tenant: TenantConfig = values.via === 'test' ? viaTestNumber(nutrifarm, values['flow-id'] ?? '') : nutrifarm;
if (values.via === 'bot' && values['flow-id']) tenant = { ...tenant, flows: { ...tenant.flows, orderFlowId: values['flow-id'] } };

/** Unpublished Flows can only be sent with mode "draft". */
function withDraftMode(inner: WhatsAppSender): WhatsAppSender {
  return {
    markRead: (t, id, o) => inner.markRead(t, id, o),
    send: (t, recipient, message, o) => {
      const params = (message as { interactive?: { type?: string; action?: { parameters?: Record<string, unknown> } } })
        .interactive;
      if (params?.type === 'flow' && params.action?.parameters) {
        const m = structuredClone(message) as OutboundMessage & {
          interactive: { action: { parameters: Record<string, unknown> } };
        };
        m.interactive.action.parameters.mode = 'draft';
        return inner.send(t, recipient, m, o);
      }
      return inner.send(t, recipient, message, o);
    },
  };
}

async function customerFor(db: Db, phone: string): Promise<Customer> {
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, nutrifarm.id), eq(customers.waId, phone)))
    .limit(1);
  return existing ?? upsertCustomer(db, nutrifarm.id, { waId: phone, bsuid: undefined, profileName: undefined } as never);
}

const sender = new GraphWhatsAppSender(env);
const deps: AppDeps = {
  env,
  now: () => new Date(),
  log: pino({ level: 'warn' }),
  db: createDb(env.DATABASE_URL),
  whatsapp: values.draft ? withDraftMode(sender) : sender,
  payments: new CashfreeProvider(env),
};

console.log(`Sending [${names.join(', ')}] to ${to} via ${values.via} number (${tenant.waPhoneNumberId})`);
const customer = await customerFor(deps.db, to);
let failed = 0;
let windowClosed = false;
for (const name of names) {
  try {
    await SAMPLES[name]!(deps, tenant, customer);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    if (/131047|re-engagement/i.test((e as Error).message)) windowClosed = true;
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
if (windowClosed)
  console.log('Hint: message the test number from your phone first (opens the 24h window), then re-run.');
process.exit(failed ? 1 : 0);
