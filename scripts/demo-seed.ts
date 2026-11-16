import { and, eq, inArray, like } from 'drizzle-orm';
import { newToken } from '../src/admin/auth/tokens.js';
import { loadEnv } from '../src/config/env.js';
import { createDbHandle } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { generateOrderCode } from '../src/domain/order-code.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

/**
 * Demo data for dashboard development (tenant nutrifarm).
 *
 *   pnpm tsx --env-file=.env.dev scripts/demo-seed.ts add      # customers, partners, pincodes, orders, payments, chats
 *   pnpm tsx --env-file=.env.dev scripts/demo-seed.ts remove   # deletes exactly what `add` creates
 *
 * Demo rows are recognised by: customers in DEMO_CUSTOMERS (by wa_key), partners in DEMO_PARTNERS (by phone),
 * pincodes in DEMO_PINCODES, and payments whose provider_ref starts with 'demo-'.
 */
const TENANT = 'nutrifarm';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

type DemoCustomer = { key: string; name: string; waId: string | null; bsuid?: string; formPhone?: string };
const DEMO_CUSTOMERS: DemoCustomer[] = [
  { key: 'avinash', name: 'Avinash', waId: '919398651343' },
  { key: 'sriraj', name: 'Sriraj', waId: '918074821477' },
  { key: 'srija', name: 'Srija', waId: '919618111780' },
  { key: 'shylu', name: 'Shylu', waId: '916301246725' },
  // A username-only (BSUID) customer: no WhatsApp number, phone typed in the order form.
  { key: 'meera', name: 'Meera', waId: null, bsuid: 'IN.DEMO0000000000001', formPhone: '9000000003' },
];
const waKeyOf = (c: DemoCustomer): string => c.bsuid ?? c.waId!;

const DEMO_PARTNERS = [
  { key: 'varun', name: 'Varun', phone: '919346878442', active: true },
  { key: 'kiran', name: 'Kiran', phone: '919000000001', active: true },
  { key: 'deepak', name: 'Deepak', phone: '919000000002', active: false },
] as const;

// Only pincodes the original seed doesn't have (it has 560034, 560102, 560076, 560068, 560037).
const DEMO_PINCODES = [
  { pincode: '560001', deliveryWeekday: 1, note: 'MG Road / Shivajinagar', active: true },
  { pincode: '560038', deliveryWeekday: 2, note: 'Indiranagar', active: true },
  { pincode: '560041', deliveryWeekday: 4, note: 'Jayanagar', active: true },
  { pincode: '560066', deliveryWeekday: 5, note: 'Whitefield (paused)', active: false },
] as const;

const ADDRESSES: Record<string, { line1: string; landmark?: string }> = {
  '560034': { line1: '14, 5th Cross, Koramangala 4th Block', landmark: 'Near Sony Signal' },
  '560037': { line1: 'Flat 302, Prestige Shantiniketan, Whitefield', landmark: 'Tower B' },
  '560001': { line1: '22, Cunningham Road', landmark: 'Opp. Café Coffee Day' },
  '560038': { line1: '640, 12th Main, HAL 2nd Stage, Indiranagar', landmark: 'Near Toit' },
  '560041': { line1: '33, 9th Block, Jayanagar', landmark: 'Opp. Jayanagar Shopping Complex' },
};
const LOCATIONS: Record<string, s.GeoLocation> = {
  '560034': { lat: 12.9352, lng: 77.6245 },
  '560038': { lat: 12.9719, lng: 77.6412 },
};

const [action] = process.argv.slice(2);
if (action !== 'add' && action !== 'remove') {
  console.error('Usage: scripts/demo-seed.ts add | remove');
  process.exit(1);
}

const { db, close } = createDbHandle(loadEnv(process.env).DATABASE_URL);
const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo);

async function remove(): Promise<void> {
  const keys = DEMO_CUSTOMERS.map(waKeyOf);
  const custs = await db
    .select({ id: s.customers.id })
    .from(s.customers)
    .where(and(eq(s.customers.tenantId, TENANT), inArray(s.customers.waKey, keys)));
  const custIds = custs.map((c) => c.id);
  if (custIds.length) {
    const ords = await db.select({ id: s.orders.id }).from(s.orders).where(inArray(s.orders.customerId, custIds));
    const ordIds = ords.map((o) => o.id);
    if (ordIds.length) {
      await db.delete(s.payments).where(inArray(s.payments.orderId, ordIds));
      await db.delete(s.orderItems).where(inArray(s.orderItems.orderId, ordIds));
      await db.delete(s.orders).where(inArray(s.orders.id, ordIds));
    }
    await db.delete(s.messages).where(inArray(s.messages.customerId, custIds));
    await db.delete(s.customers).where(inArray(s.customers.id, custIds));
  }
  await db.delete(s.payments).where(and(eq(s.payments.tenantId, TENANT), like(s.payments.providerRef, 'demo-%')));
  // Unassign any non-demo orders from demo partners before deleting them (none expected).
  const parts = await db
    .select({ id: s.deliveryPartners.id })
    .from(s.deliveryPartners)
    .where(
      and(
        eq(s.deliveryPartners.tenantId, TENANT),
        inArray(
          s.deliveryPartners.phone,
          DEMO_PARTNERS.map((p) => p.phone),
        ),
      ),
    );
  if (parts.length) {
    const partIds = parts.map((p) => p.id);
    const still = await db.select({ id: s.orders.id }).from(s.orders).where(inArray(s.orders.assignedPartnerId, partIds));
    if (still.length) throw new Error(`${still.length} non-demo orders are assigned to demo partners; reassign them first`);
    await db.delete(s.deliveryPartners).where(inArray(s.deliveryPartners.id, partIds));
  }
  await db.delete(s.pincodes).where(
    and(
      eq(s.pincodes.tenantId, TENANT),
      inArray(
        s.pincodes.pincode,
        DEMO_PINCODES.map((p) => p.pincode),
      ),
    ),
  );
  console.log(`Removed demo data: ${custIds.length} customers (with their orders, payments, messages), ${parts.length} partners, demo pincodes.`);
}

async function add(): Promise<void> {
  const existing = await db
    .select({ id: s.customers.id })
    .from(s.customers)
    .where(and(eq(s.customers.tenantId, TENANT), inArray(s.customers.waKey, DEMO_CUSTOMERS.map(waKeyOf))));
  if (existing.length) throw new Error('Demo data already present; run `remove` first');

  const products = await db
    .select()
    .from(s.products)
    .where(and(eq(s.products.tenantId, TENANT), eq(s.products.active, true)))
    .orderBy(s.products.sortOrder);
  if (products.length < 2) throw new Error('Need at least 2 active products');
  const [ravi] = await db
    .select()
    .from(s.deliveryPartners)
    .where(and(eq(s.deliveryPartners.tenantId, TENANT), eq(s.deliveryPartners.name, 'Ravi')));
  if (!ravi) throw new Error('Partner Ravi not found');

  for (const p of DEMO_PINCODES) {
    await db.insert(s.pincodes).values({ tenantId: TENANT, ...p }).onConflictDoNothing();
  }

  const partners: Record<string, string> = { ravi: ravi.id };
  for (const p of DEMO_PARTNERS) {
    const [row] = await db
      .insert(s.deliveryPartners)
      .values({
        tenantId: TENANT,
        name: p.name,
        phone: p.phone,
        active: p.active,
        accessToken: newToken(),
        accessTokenCreatedAt: at(2 * DAY),
        createdAt: at(10 * DAY),
      })
      .returning();
    partners[p.key] = row!.id;
  }

  const cust: Record<string, { id: string; name: string; phone10: string; waId: string | null }> = {};
  for (const [i, c] of DEMO_CUSTOMERS.entries()) {
    const phone10 = c.formPhone ?? c.waId!.slice(2);
    const [row] = await db
      .insert(s.customers)
      .values({
        tenantId: TENANT,
        waKey: waKeyOf(c),
        waId: c.waId,
        bsuid: c.bsuid ?? null,
        profileName: c.waId ? c.name : null,
        email: c.key === 'srija' ? 'srija.demo@example.com' : null,
        defaultAddress: { name: c.name, ...ADDRESSES['560034']!, pincode: '560034', ...(c.waId ? {} : { phone: phone10 }) },
        createdAt: at((14 - i) * DAY),
      })
      .returning();
    cust[c.key] = { id: row!.id, name: c.name, phone10, waId: c.waId };
  }

  type Spec = {
    c: string;
    status: (typeof s.orderStatusEnum.enumValues)[number];
    pin: string;
    date: string;
    items: [number, number][];
    partner?: string;
    pay: 'created' | 'paid' | 'failed' | 'expired' | 'refunded';
    createdAgo: number;
    deliveredAgo?: number;
  };
  const specs: Spec[] = [
    { c: 'shylu', status: 'payment_pending', pin: '560034', date: '2026-11-18', items: [[0, 2]], pay: 'created', createdAgo: 20 * MIN },
    { c: 'avinash', status: 'confirmed', pin: '560034', date: '2026-11-18', items: [[0, 1], [1, 1]], pay: 'paid', createdAgo: 3 * HOUR },
    { c: 'srija', status: 'confirmed', pin: '560001', date: '2026-11-23', items: [[1, 2]], pay: 'paid', createdAgo: 5 * HOUR },
    { c: 'meera', status: 'confirmed', pin: '560038', date: '2026-11-17', items: [[0, 3]], pay: 'paid', createdAgo: 9 * HOUR },
    { c: 'sriraj', status: 'assigned', pin: '560037', date: '2026-11-21', items: [[1, 1]], partner: 'ravi', pay: 'paid', createdAgo: 26 * HOUR },
    { c: 'shylu', status: 'assigned', pin: '560034', date: '2026-11-18', items: [[0, 1]], partner: 'varun', pay: 'paid', createdAgo: 30 * HOUR },
    { c: 'avinash', status: 'assigned', pin: '560041', date: '2026-11-19', items: [[0, 2], [1, 1]], partner: 'kiran', pay: 'paid', createdAgo: 2 * DAY },
    { c: 'srija', status: 'out_for_delivery', pin: '560001', date: '2026-11-16', items: [[0, 1]], partner: 'ravi', pay: 'paid', createdAgo: 4 * DAY },
    { c: 'sriraj', status: 'out_for_delivery', pin: '560001', date: '2026-11-16', items: [[1, 2]], partner: 'varun', pay: 'paid', createdAgo: 5 * DAY },
    { c: 'avinash', status: 'delivered', pin: '560034', date: '2026-11-11', items: [[0, 2]], partner: 'ravi', pay: 'paid', createdAgo: 8 * DAY, deliveredAgo: 5 * DAY },
    { c: 'srija', status: 'delivered', pin: '560037', date: '2026-11-14', items: [[1, 1]], partner: 'varun', pay: 'paid', createdAgo: 6 * DAY, deliveredAgo: 2 * DAY },
    { c: 'shylu', status: 'delivered', pin: '560038', date: '2026-11-10', items: [[0, 1], [1, 1]], partner: 'kiran', pay: 'paid', createdAgo: 9 * DAY, deliveredAgo: 6 * DAY },
    { c: 'sriraj', status: 'delivered', pin: '560041', date: '2026-11-12', items: [[0, 4]], partner: 'ravi', pay: 'paid', createdAgo: 7 * DAY, deliveredAgo: 4 * DAY },
    { c: 'meera', status: 'cancelled', pin: '560034', date: '2026-11-18', items: [[1, 1]], pay: 'paid', createdAgo: 28 * HOUR },
    { c: 'avinash', status: 'cancelled', pin: '560001', date: '2026-11-23', items: [[0, 1]], pay: 'refunded', createdAgo: 3 * DAY },
    { c: 'srija', status: 'payment_failed', pin: '560038', date: '2026-11-17', items: [[0, 2]], pay: 'failed', createdAgo: 6 * HOUR },
    { c: 'shylu', status: 'expired', pin: '560037', date: '2026-11-21', items: [[1, 1]], pay: 'expired', createdAgo: 2 * DAY },
    { c: 'sriraj', status: 'expired', pin: '560034', date: '2026-11-18', items: [[0, 1]], pay: 'paid', createdAgo: 2 * DAY },
  ];

  for (const sp of specs) {
    const c = cust[sp.c]!;
    const lines = sp.items.map(([pi, quantity], position) => {
      const p = products[pi % products.length]!;
      return { p, quantity, position, line: p.pricePaise * quantity };
    });
    const subtotal = lines.reduce((a, l) => a + l.line, 0);
    const created = at(sp.createdAgo);
    const paidAt = sp.pay === 'paid' || sp.pay === 'refunded' ? new Date(created.getTime() + 4 * MIN) : null;
    const [o] = await db
      .insert(s.orders)
      .values({
        tenantId: TENANT,
        orderCode: generateOrderCode('NF'),
        customerId: c.id,
        source: 'one_time',
        status: sp.status,
        deliveryDate: sp.date,
        address: { name: c.name, ...ADDRESSES[sp.pin]!, pincode: sp.pin, phone: c.phone10 },
        location: LOCATIONS[sp.pin] ?? null,
        pincode: sp.pin,
        subtotalPaise: subtotal,
        deliveryFeePaise: 0,
        totalPaise: subtotal,
        assignedPartnerId: sp.partner ? partners[sp.partner]! : null,
        paidAt: sp.status === 'expired' && sp.pay === 'paid' ? new Date(created.getTime() + 50 * HOUR) : paidAt,
        deliveredAt: sp.deliveredAgo ? at(sp.deliveredAgo) : null,
        createdAt: created,
        updatedAt: sp.deliveredAgo ? at(sp.deliveredAgo) : created,
      })
      .returning();
    await db.insert(s.orderItems).values(
      lines.map((l) => ({
        orderId: o!.id,
        productId: l.p.id,
        name: l.p.name,
        unitPricePaise: l.p.pricePaise,
        position: l.position,
        quantity: l.quantity,
        lineTotalPaise: l.line,
      })),
    );
    await db.insert(s.payments).values({
      tenantId: TENANT,
      orderId: o!.id,
      kind: 'link',
      providerRef: `demo-${o!.id}`,
      amountPaise: subtotal,
      status: sp.pay,
      linkUrl: 'https://payments-test.cashfree.com/links/demo',
      raw: { demo: true },
      createdAt: created,
      updatedAt: paidAt ?? created,
    });
  }

  // Chats (messages are purged after 3 days by the nightly job).
  const welcome = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Hi! Welcome to NutriFarm Eggs. What would you like to do?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'order', title: 'Place an order' } },
          { type: 'reply', reply: { id: 'my_orders', title: 'My orders' } },
          { type: 'reply', reply: { id: 'help', title: 'Help' } },
        ],
      },
    },
  };
  const msgs: { c: string; dir: 'in' | 'out'; ago: number; type: string; text: string; payload: unknown }[] = [
    { c: 'avinash', dir: 'in', ago: 3 * HOUR + 10 * MIN, type: 'text', text: 'Hi', payload: { type: 'text', text: { body: 'Hi' } } },
    { c: 'avinash', dir: 'out', ago: 3 * HOUR + 9 * MIN, type: 'interactive', text: 'Hi! Welcome to NutriFarm Eggs. What would you like to do?', payload: welcome },
    { c: 'avinash', dir: 'in', ago: 3 * HOUR + 8 * MIN, type: 'button', text: 'Place an order', payload: { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'order', title: 'Place an order' } } } },
    { c: 'avinash', dir: 'out', ago: 3 * HOUR, type: 'text', text: 'Payment received. Your order is confirmed for Wed, 18 Nov.', payload: { type: 'text', text: { body: 'Payment received. Your order is confirmed for Wed, 18 Nov.' } } },
    { c: 'avinash', dir: 'in', ago: 40 * MIN, type: 'text', text: 'Can you deliver before 9 am?', payload: { type: 'text', text: { body: 'Can you deliver before 9 am?' } } },
    { c: 'srija', dir: 'in', ago: 5 * HOUR + 5 * MIN, type: 'text', text: 'Hello, do you have brown eggs?', payload: { type: 'text', text: { body: 'Hello, do you have brown eggs?' } } },
    { c: 'srija', dir: 'out', ago: 5 * HOUR + 4 * MIN, type: 'interactive', text: 'Hi! Welcome to NutriFarm Eggs. What would you like to do?', payload: welcome },
    { c: 'srija', dir: 'in', ago: 5 * HOUR + 2 * MIN, type: 'location', text: '[location 12.9716,77.5946]', payload: { type: 'location', location: { latitude: 12.9716, longitude: 77.5946 } } },
    { c: 'shylu', dir: 'in', ago: 30 * HOUR, type: 'text', text: 'Is delivery free?', payload: { type: 'text', text: { body: 'Is delivery free?' } } },
    { c: 'shylu', dir: 'out', ago: 30 * HOUR - MIN, type: 'text', text: 'Yes, delivery is free. Minimum order is ₹90.', payload: { type: 'text', text: { body: 'Yes, delivery is free. Minimum order is ₹90.' } } },
  ];
  for (const m of msgs) {
    await db.insert(s.messages).values({
      tenantId: TENANT,
      customerId: cust[m.c]!.id,
      direction: m.dir,
      waMessageId: null,
      type: m.type,
      text: m.text,
      payload: m.payload as object,
      createdAt: at(m.ago),
    });
  }
  console.log(
    `Added demo data: ${DEMO_CUSTOMERS.length} customers, ${DEMO_PARTNERS.length} partners, ${DEMO_PINCODES.length} pincodes, ${specs.length} orders with payments, ${msgs.length} chat messages.`,
  );
}

try {
  if (action === 'add') await add();
  else await remove();
} finally {
  await close();
}
