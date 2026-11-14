import type { Product } from '../catalog/catalog-repo.js';
import type { Address, Customer } from '../customers/customer-repo.js';
import type { Db } from '../db/client.js';
import { orderItems, orders, type GeoLocation } from '../db/schema.js';
import { generateOrderCode } from '../domain/order-code.js';
import { normalizePincode } from '../domain/pincode.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';
import { findOrderById, type OrderWithItems } from './order-repo.js';

export interface OrderLine {
  product: Product;
  quantity: number;
}

export type OrderSubmission =
  /** `phone` is the raw Flow field (unvalidated); the submit handler decides whether it is needed. */
  | { lines: OrderLine[]; address: Address; phone: string }
  | { error: 'no_items' }
  | { error: 'invalid_pincode'; raw: string }
  | { error: 'invalid_address' };

const MAX_QTY = 10;
const MAX_NAME = 80;
const MAX_LINE1 = 300;
const MAX_LANDMARK = 100;

/** Integers 0..10 (number or numeric string) only; anything else counts as 0. */
function parseQty(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_QTY ? n : 0;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * Maps `qty_<slot>` to products via `slotMap`, using only slotMap keys. Slots whose product is no longer active
 * are ignored; a product in several slots sums. Check order: no_items, invalid_pincode, invalid_address.
 */
export function parseOrderSubmission(
  response: Record<string, unknown>,
  slotMap: Record<string, string>,
  products: Product[],
): OrderSubmission {
  const byId = new Map(products.map((p) => [p.id, p]));
  const qtyByProduct = new Map<string, number>();
  for (const [slot, productId] of Object.entries(slotMap)) {
    const product = byId.get(productId);
    if (!product) continue;
    const q = parseQty(response[`qty_${slot}`]);
    if (q > 0) qtyByProduct.set(productId, (qtyByProduct.get(productId) ?? 0) + q);
  }
  const lines: OrderLine[] = [...qtyByProduct].map(([id, quantity]) => ({ product: byId.get(id)!, quantity }));
  if (lines.length === 0) return { error: 'no_items' };

  const rawPincode = str(response.pincode);
  const pincode = normalizePincode(rawPincode);
  if (!pincode) return { error: 'invalid_pincode', raw: rawPincode };

  const name = str(response.name);
  const line1 = str(response.line1);
  const landmark = str(response.landmark);
  if (!name || !line1 || name.length > MAX_NAME || line1.length > MAX_LINE1 || landmark.length > MAX_LANDMARK) {
    return { error: 'invalid_address' };
  }
  return { lines, address: { name, line1, ...(landmark ? { landmark } : {}), pincode }, phone: str(response.phone) };
}

export interface CreateOrderInput {
  lines: OrderLine[];
  address: Address;
  location: GeoLocation | null;
  status: 'payment_pending' | 'confirmed';
  source: 'one_time' | 'subscription';
  subscriptionId?: string;
  deliveryDate: string;
  /** productId -> paise; overrides DB price (subscription charges). */
  unitPrices?: Record<string, number>;
}

const ORDER_CODE_CONSTRAINT = 'orders_tenant_order_code_uq';

/**
 * True for a Postgres unique violation (23505) on the order_code constraint only. PGlite/postgres-js/drizzle put
 * the fields at different depths (`.cause`), and name the constraint `constraint` or `constraint_name`;
 * the message is a last-resort fallback.
 */
export function isOrderCodeCollision(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === 'object' && i < 5; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
    if (x.code !== '23505') continue;
    const name = x.constraint_name ?? x.constraint;
    if (typeof name === 'string') return name === ORDER_CODE_CONSTRAINT;
    return typeof x.message === 'string' && x.message.includes(ORDER_CODE_CONSTRAINT);
  }
  return false;
}

const MAX_CODE_ATTEMPTS = 3;

/** Order + items in one transaction; totals from DB prices (snapshotted into order_items). */
export async function createOrder(
  deps: { db: Db },
  tenant: TenantConfig,
  customer: Customer,
  input: CreateOrderInput,
  opts: { random?: (n: number) => Uint8Array } = {},
): Promise<OrderWithItems> {
  const settings = await getTenantSettings(deps.db, tenant.id);
  const priced = input.lines.map((l) => {
    const unit = input.unitPrices?.[l.product.id] ?? l.product.pricePaise;
    return { product: l.product, quantity: l.quantity, unit, total: unit * l.quantity };
  });
  const subtotal = priced.reduce((s, l) => s + l.total, 0);
  const fee = settings.deliveryFeePaise;

  for (let attempt = 1; ; attempt++) {
    try {
      const orderId = await deps.db.transaction(async (tx) => {
        const [o] = await tx
          .insert(orders)
          .values({
            tenantId: tenant.id,
            orderCode: generateOrderCode(tenant.orderCodePrefix, opts.random),
            customerId: customer.id,
            source: input.source,
            subscriptionId: input.subscriptionId ?? null,
            status: input.status,
            deliveryDate: input.deliveryDate,
            address: input.address,
            location: input.location,
            pincode: input.address.pincode,
            subtotalPaise: subtotal,
            deliveryFeePaise: fee,
            totalPaise: subtotal + fee,
          })
          .returning({ id: orders.id });
        await tx.insert(orderItems).values(
          priced.map((l, position) => ({
            position,
            orderId: o!.id,
            productId: l.product.id,
            name: l.product.name,
            unitPricePaise: l.unit,
            quantity: l.quantity,
            lineTotalPaise: l.total,
          })),
        );
        return o!.id;
      });
      return (await findOrderById(deps.db, tenant.id, orderId))!;
    } catch (err) {
      if (!isOrderCodeCollision(err) || attempt >= MAX_CODE_ATTEMPTS) throw err;
    }
  }
}
