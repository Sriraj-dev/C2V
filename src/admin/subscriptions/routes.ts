import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { cancelSubscription } from '../../subscriptions/subscription-service.js';
import { ApiError, pageParams, paged, parseQuery, type AdminEnv } from '../http.js';
import { getSubscriptionDetail, listSubscriptions, type SubscriptionStatus } from './queries.js';

const STATUSES = ['pending_authorization', 'active', 'cancelled', 'authorization_failed'] as const satisfies readonly SubscriptionStatus[];

const listQuery = pageParams.extend({
  status: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(STATUSES)).min(1))
    .optional(),
});

const uuid = z.string().uuid();

export function subscriptionRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  const detailOr404 = async (tenantId: string, id: string) => {
    if (!uuid.safeParse(id).success) throw new ApiError(404, 'not_found', 'Not found');
    const sub = await getSubscriptionDetail(deps.db, tenantId, id);
    if (!sub) throw new ApiError(404, 'not_found', 'Not found');
    return sub;
  };

  r.get('/subscriptions', async (c) => {
    const { page, pageSize, status } = parseQuery(c, listQuery);
    const { items, total } = await listSubscriptions(deps.db, c.get('tenant').id, { statuses: status, page, pageSize });
    return c.json(paged(items, page, pageSize, total));
  });

  r.get('/subscriptions/:id', async (c) => {
    return c.json({ subscription: await detailOr404(c.get('tenant').id, c.req.param('id')) });
  });

  // Cashfree is cancelled first; a Cashfree failure is a 502 provider_error and nothing changes.
  r.post('/subscriptions/:id/cancel', async (c) => {
    const tenant = c.get('tenant');
    const id = c.req.param('id');
    await detailOr404(tenant.id, id);
    const result = await cancelSubscription(deps, tenant, id);
    return c.json({ result, subscription: await detailOr404(tenant.id, id) });
  });

  return r;
}
