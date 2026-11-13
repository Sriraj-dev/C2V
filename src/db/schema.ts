import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export type Address = { name: string; line1: string; landmark?: string; pincode: string };
export type GeoLocation = { lat: number; lng: number };
export type ChargeItem = {
  productId: string;
  name: string;
  unitPricePaise: number;
  quantity: number;
};

export const orderSourceEnum = pgEnum('order_source', ['one_time', 'subscription']);
export const orderStatusEnum = pgEnum('order_status', [
  'payment_pending',
  'confirmed',
  'assigned',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'payment_failed',
  'expired',
]);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'pending_authorization',
  'active',
  'cancelled',
  'authorization_failed',
]);
export const subscriptionFrequencyEnum = pgEnum('subscription_frequency', [
  'weekly',
  'biweekly',
  'monthly',
]);
export const paymentKindEnum = pgEnum('payment_kind', ['link', 'subscription_charge']);
export const paymentStatusEnum = pgEnum('payment_status', [
  'created',
  'paid',
  'failed',
  'expired',
  'refunded',
]);
export const messageDirectionEnum = pgEnum('message_direction', ['in', 'out']);

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const tenantId = () => text('tenant_id').notNull().references(() => tenants.id);

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  supportPhone: text('support_phone'),
  welcomeImageUrl: text('welcome_image_url'),
  deliveryFeePaise: integer('delivery_fee_paise').notNull().default(0),
  minOrderPaise: integer('min_order_paise').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable(
  'customers',
  {
    id: id(),
    tenantId: tenantId(),
    waKey: text('wa_key').notNull(),
    waId: text('wa_id'),
    bsuid: text('bsuid'),
    profileName: text('profile_name'),
    email: text('email'),
    defaultAddress: jsonb('default_address').$type<Address>(),
    defaultLocation: jsonb('default_location').$type<GeoLocation>(),
    createdAt: createdAt(),
  },
  (t) => [unique('customers_tenant_wa_key_uq').on(t.tenantId, t.waKey)],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    tenantId: tenantId(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    pricePaise: integer('price_paise').notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique('products_tenant_sku_uq').on(t.tenantId, t.sku)],
);

export const pincodes = pgTable(
  'pincodes',
  {
    id: id(),
    tenantId: tenantId(),
    pincode: char('pincode', { length: 6 }).notNull(),
    deliveryWeekday: smallint('delivery_weekday').notNull(),
    active: boolean('active').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [unique('pincodes_tenant_pincode_uq').on(t.tenantId, t.pincode)],
);

export const deliveryPartners = pgTable('delivery_partners', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    status: subscriptionStatusEnum('status').notNull(),
    frequency: subscriptionFrequencyEnum('frequency').notNull().default('weekly'),
    address: jsonb('address').$type<Address>().notNull(),
    location: jsonb('location').$type<GeoLocation>(),
    pincode: char('pincode', { length: 6 }).notNull(),
    deliveryWeekday: smallint('delivery_weekday').notNull(),
    perDeliveryTotalPaise: integer('per_delivery_total_paise').notNull(),
    nextDeliveryDate: date('next_delivery_date', { mode: 'string' }),
    cfSubscriptionId: text('cf_subscription_id').unique(),
    authLink: text('auth_link'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('subscriptions_tenant_status_next_idx').on(t.tenantId, t.status, t.nextDeliveryDate),
    index('subscriptions_customer_idx').on(t.customerId),
  ],
);

export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: id(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    quantity: integer('quantity').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('subscription_items_subscription_idx').on(t.subscriptionId),
    index('subscription_items_product_idx').on(t.productId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: tenantId(),
    orderCode: text('order_code').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    source: orderSourceEnum('source').notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    status: orderStatusEnum('status').notNull(),
    deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
    address: jsonb('address').$type<Address>().notNull(),
    location: jsonb('location').$type<GeoLocation>(),
    pincode: char('pincode', { length: 6 }).notNull(),
    subtotalPaise: integer('subtotal_paise').notNull(),
    deliveryFeePaise: integer('delivery_fee_paise').notNull(),
    totalPaise: integer('total_paise').notNull(),
    assignedPartnerId: uuid('assigned_partner_id').references(() => deliveryPartners.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('orders_tenant_order_code_uq').on(t.tenantId, t.orderCode),
    index('orders_tenant_status_delivery_idx').on(t.tenantId, t.status, t.deliveryDate),
    index('orders_subscription_idx').on(t.subscriptionId),
    index('orders_customer_idx').on(t.customerId),
    index('orders_assigned_partner_idx').on(t.assignedPartnerId),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalPaise: integer('line_total_paise').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    index('order_items_product_idx').on(t.productId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').references(() => orders.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    forDeliveryDate: date('for_delivery_date', { mode: 'string' }),
    chargeItems: jsonb('charge_items').$type<ChargeItem[]>(),
    provider: text('provider').notNull().default('cashfree'),
    kind: paymentKindEnum('kind').notNull(),
    providerRef: text('provider_ref').notNull().unique(),
    amountPaise: integer('amount_paise').notNull(),
    status: paymentStatusEnum('status').notNull(),
    linkUrl: text('link_url'),
    raw: jsonb('raw'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('payments_subscription_delivery_uq').on(t.subscriptionId, t.forDeliveryDate),
    index('payments_order_idx').on(t.orderId),
    index('payments_tenant_idx').on(t.tenantId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    direction: messageDirectionEnum('direction').notNull(),
    waMessageId: text('wa_message_id').unique(),
    type: text('type').notNull(),
    text: text('text'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_tenant_customer_created_idx').on(t.tenantId, t.customerId, t.createdAt),
    index('messages_created_idx').on(t.createdAt),
  ],
);

export type TenantRow = typeof tenants.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type PincodeRow = typeof pincodes.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
