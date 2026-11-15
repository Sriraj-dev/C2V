import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { ApiError, pageParams, paged, parseQuery, type AdminEnv } from '../http.js';
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

  r.get('/refunds/needed', async (c) => {
    return c.json({ items: await listNeedsRefund(deps.db, c.get('tenant').id) });
  });

  return r;
}
