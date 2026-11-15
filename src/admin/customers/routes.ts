import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { ApiError, pageParams, paged, parseQuery, type AdminEnv } from '../http.js';
import { getCustomer, listCustomers } from './queries.js';

const listQuery = pageParams.extend({ q: z.string().max(100).optional() });

export function customerRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/customers', async (c) => {
    const { page, pageSize, q } = parseQuery(c, listQuery);
    const { items, total } = await listCustomers(deps.db, c.get('tenant').id, { q, page, pageSize });
    return c.json(paged(items, page, pageSize, total));
  });

  r.get('/customers/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, 'not_found', 'Not found');
    const found = await getCustomer(deps.db, c.get('tenant').id, id);
    if (!found) throw new ApiError(404, 'not_found', 'Not found');
    return c.json(found);
  });

  return r;
}
