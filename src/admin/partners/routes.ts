import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { normalizeIndianPhone } from '../../domain/phone.js';
import { ApiError, parseBody, type AdminEnv } from '../http.js';
import { createPartner, listPartners, resetPartnerLink, updatePartner } from './repo.js';

const name = z.string().trim().min(1).max(60);
const phone = z.string().transform((s, ctx) => {
  const p = normalizeIndianPhone(s);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Must be a 10-digit Indian mobile number' });
  return p as string;
});

const partnerCreate = z.object({ name, phone }).strict();
const partnerPatch = z
  .object({ name, phone, active: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field');

function idParam(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw new ApiError(404, 'not_found', 'Not found');
  return raw;
}

export function partnerAdminRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/partners', async (c) => c.json({ items: await listPartners(deps.db, c.get('tenant').id) }));

  r.post('/partners', async (c) => {
    const body = await parseBody(c, partnerCreate);
    return c.json({ partner: await createPartner(deps.db, c.get('tenant').id, body, deps.now()) }, 201);
  });

  r.patch('/partners/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = await parseBody(c, partnerPatch);
    const partner = await updatePartner(deps.db, c.get('tenant').id, id, patch);
    if (!partner) throw new ApiError(404, 'not_found', 'Not found');
    return c.json({ partner });
  });

  r.post('/partners/:id/reset-link', async (c) => {
    const id = idParam(c.req.param('id'));
    const partner = await resetPartnerLink(deps.db, c.get('tenant').id, id, deps.now());
    if (!partner) throw new ApiError(404, 'not_found', 'Not found');
    return c.json({ partner });
  });

  return r;
}
