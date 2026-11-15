import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { refundOrder, updateStatus } from '../../orders/order-status.js';
import { errInfo } from '../../bot/log.js';
import { ApiError, pageParams, paged, parseBody, parseQuery, toApiError, type AdminEnv } from '../http.js';
import { getOrderView, listActiveOrders, listNeedsRefund, listOrders } from './queries.js';
import type { OrderStatus } from './views.js';

const STATUSES = [
  'payment_pending',
  'confirmed',
  'assigned',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'payment_failed',
  'expired',
] as const satisfies readonly OrderStatus[];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const listQuery = pageParams.extend({
  status: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(STATUSES)).min(1))
    .optional(),
  deliveryFrom: date.optional(),
  deliveryTo: date.optional(),
  pincode: z.string().regex(/^\d{6}$/, 'Expected 6 digits').optional(),
  partnerId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
});

const uuid = z.string().uuid();

export function orderRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/orders/active', async (c) => {
    return c.json({ items: await listActiveOrders(deps.db, c.get('tenant').id) });
  });

  r.get('/orders', async (c) => {
    const { page, pageSize, status, ...rest } = parseQuery(c, listQuery);
    const { items, total } = await listOrders(deps.db, c.get('tenant').id, {
      ...rest,
      statuses: status,
      page,
      pageSize,
    });
    return c.json(paged(items, page, pageSize, total));
  });

  r.get('/orders/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) throw new ApiError(404, 'not_found', 'Not found');
    const order = await getOrderView(deps.db, c.get('tenant').id, id);
    if (!order) throw new ApiError(404, 'not_found', 'Not found');
    return c.json({ order });
  });

  const orderIdOr404 = (id: string): string => {
    if (!uuid.safeParse(id).success) throw new ApiError(404, 'not_found', 'Not found');
    return id;
  };
  const freshView = async (tenantId: string, id: string) => {
    const order = await getOrderView(deps.db, tenantId, id);
    if (!order) throw new ApiError(404, 'not_found', 'Not found');
    return order;
  };

  const assignBody = z.object({ partnerId: z.string().uuid() });
  const bulkBody = z.object({ orderIds: z.array(z.string().uuid()).min(1).max(100), partnerId: z.string().uuid() });

  // Registered before `/orders/:id/...` routes; the literal path cannot clash (different method/segments).
  r.post('/orders/bulk-assign', async (c) => {
    const tenant = c.get('tenant');
    const { orderIds, partnerId } = await parseBody(c, bulkBody);
    const results: unknown[] = [];
    for (const orderId of [...new Set(orderIds)]) {
      try {
        await updateStatus(deps, tenant, orderId, 'assigned', { partnerId });
        results.push({ orderId, ok: true, order: await freshView(tenant.id, orderId) });
      } catch (err) {
        const api = toApiError(err);
        if (!api) deps.log.error({ err: errInfo(err), orderId }, 'bulk assign failed unexpectedly');
        results.push({
          orderId,
          ok: false,
          error: api ? { code: api.code, message: api.message } : { code: 'internal', message: 'Internal error' },
        });
      }
    }
    return c.json({ results });
  });

  r.post('/orders/:id/assign', async (c) => {
    const id = orderIdOr404(c.req.param('id'));
    const { partnerId } = await parseBody(c, assignBody);
    const tenant = c.get('tenant');
    await updateStatus(deps, tenant, id, 'assigned', { partnerId });
    return c.json({ order: await freshView(tenant.id, id) });
  });

  r.post('/orders/:id/out-for-delivery', async (c) => {
    const id = orderIdOr404(c.req.param('id'));
    const tenant = c.get('tenant');
    await updateStatus(deps, tenant, id, 'out_for_delivery');
    return c.json({ order: await freshView(tenant.id, id) });
  });

  r.post('/orders/:id/delivered', async (c) => {
    const id = orderIdOr404(c.req.param('id'));
    const tenant = c.get('tenant');
    const { notified } = await updateStatus(deps, tenant, id, 'delivered');
    return c.json({ order: await freshView(tenant.id, id), notified });
  });

  r.post('/orders/:id/cancel', async (c) => {
    const id = orderIdOr404(c.req.param('id'));
    const tenant = c.get('tenant');
    await updateStatus(deps, tenant, id, 'cancelled');
    return c.json({ order: await freshView(tenant.id, id) });
  });

  r.post('/orders/:id/refund', async (c) => {
    const id = orderIdOr404(c.req.param('id'));
    const tenant = c.get('tenant');
    const result = await refundOrder(deps, tenant, id);
    return c.json({ result, order: await freshView(tenant.id, id) });
  });

  r.get('/refunds/needed', async (c) => {
    return c.json({ items: await listNeedsRefund(deps.db, c.get('tenant').id) });
  });

  return r;
}
