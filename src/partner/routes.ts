import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { findPartnerByToken } from '../admin/partners/repo.js';
import { ApiError, errorResponse } from '../admin/http.js';
import { orderPhone } from '../admin/orders/views.js';
import type { Db } from '../db/client.js';
import { customers, orderItems, orders, type Address, type DeliveryPartnerRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { updateStatus } from '../orders/order-status.js';
import { tenantById } from '../tenants/registry.js';
import type { TenantConfig } from '../tenants/types.js';

type PartnerEnv = { Variables: { partner: DeliveryPartnerRow; tenant: TenantConfig } };

export interface PartnerOrderView {
  id: string;
  orderCode: string;
  status: (typeof orders.$inferSelect)['status'];
  deliveryDate: string;
  address: Address;
  mapUrl: string | null;
  customerName: string;
  customerPhone: string | null;
  items: { name: string; quantity: number }[];
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OPEN = ['assigned', 'out_for_delivery'] as const;
const uuid = z.string().uuid();
const notFound = () => new ApiError(404, 'not_found', 'Not found');

async function toPartnerViews(db: Db, tenantId: string, rows: (typeof orders.$inferSelect)[]): Promise<PartnerOrderView[]> {
  if (rows.length === 0) return [];
  const [itemRows, customerRows] = await Promise.all([
    db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(orderItems.position), asc(orderItems.createdAt)),
    db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          inArray(customers.id, [...new Set(rows.map((r) => r.customerId))]),
        ),
      ),
  ]);
  const customerById = new Map(customerRows.map((c) => [c.id, c]));
  return rows.map((r) => ({
    id: r.id,
    orderCode: r.orderCode,
    status: r.status,
    deliveryDate: r.deliveryDate,
    address: r.address,
    mapUrl: r.location ? `https://maps.google.com/?q=${r.location.lat},${r.location.lng}` : null,
    customerName: r.address.name,
    customerPhone: orderPhone(customerById.get(r.customerId)?.waId, r.address),
    items: itemRows.filter((i) => i.orderId === r.id).map((i) => ({ name: i.name, quantity: i.quantity })),
  }));
}

/** The no-login delivery-partner API at /partner/:token. The token is the only credential and is never logged. */
export function partnerRoutes(deps: AppDeps): Hono<PartnerEnv> {
  const r = new Hono<PartnerEnv>();
  r.onError((err, c) => {
    const res = errorResponse(c, err, deps.log);
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('Cache-Control', 'no-store');
    return res;
  });

  r.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  r.use('/:token/*', async (c, next) => {
    const token = c.req.param('token');
    // Shape check first: junk never reaches the database.
    if (!TOKEN_RE.test(token)) throw notFound();
    const partner = await findPartnerByToken(deps.db, token);
    const tenant = partner ? tenantById(partner.tenantId) : null;
    if (!partner || !tenant) throw notFound();
    c.set('partner', partner);
    c.set('tenant', tenant);
    await next();
  });

  r.get('/:token/orders', async (c) => {
    const partner = c.get('partner');
    const rows = await deps.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, partner.tenantId),
          eq(orders.assignedPartnerId, partner.id),
          inArray(orders.status, [...OPEN]),
        ),
      )
      .orderBy(asc(orders.deliveryDate), asc(orders.createdAt), asc(orders.id));
    return c.json({ partner: { name: partner.name }, items: await toPartnerViews(deps.db, partner.tenantId, rows) });
  });

  /** Loads the order only if it is this partner's and still open; otherwise 404. */
  async function ownOpenOrder(partner: DeliveryPartnerRow, rawId: string): Promise<string> {
    if (!uuid.safeParse(rawId).success) throw notFound();
    const [row] = await deps.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, partner.tenantId),
          eq(orders.id, rawId),
          eq(orders.assignedPartnerId, partner.id),
          inArray(orders.status, [...OPEN]),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    return row.id;
  }

  async function freshView(partner: DeliveryPartnerRow, id: string): Promise<PartnerOrderView> {
    const [row] = await deps.db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, partner.tenantId), eq(orders.id, id), eq(orders.assignedPartnerId, partner.id)))
      .limit(1);
    if (!row) throw notFound();
    return (await toPartnerViews(deps.db, partner.tenantId, [row]))[0]!;
  }

  r.post('/:token/orders/:orderId/out-for-delivery', async (c) => {
    const partner = c.get('partner');
    const id = await ownOpenOrder(partner, c.req.param('orderId'));
    await updateStatus(deps, c.get('tenant'), id, 'out_for_delivery', { actorPartnerId: partner.id });
    return c.json({ order: await freshView(partner, id) });
  });

  r.post('/:token/orders/:orderId/delivered', async (c) => {
    const partner = c.get('partner');
    const id = await ownOpenOrder(partner, c.req.param('orderId'));
    const { notified } = await updateStatus(deps, c.get('tenant'), id, 'delivered', { actorPartnerId: partner.id });
    return c.json({ order: await freshView(partner, id), notified });
  });

  r.all('*', () => {
    throw notFound();
  });

  return r;
}
