import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { normalizePincode } from '../../domain/pincode.js';
import { ApiError, parseBody, type AdminEnv } from '../http.js';
import { createPincode, listPincodes, updatePincode } from './pincodes-repo.js';
import { createProduct, listProducts, updateProduct } from './products-repo.js';

const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use 1-40 letters, digits, - and _')
  .transform((s) => s.toUpperCase());
const name = z.string().trim().min(1).max(60);
const pricePaise = z.number().int().min(1).max(10_000_000);
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);

const productCreate = z
  .object({ sku, name, pricePaise, sortOrder: sortOrder.optional(), active: z.boolean().optional() })
  .strict();

const productPatch = z
  .object({ sku, name, pricePaise, sortOrder, active: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field');

const weekday = z.number().int().min(0).max(6);
// Empty after trimming means no note.
const note = z
  .string()
  .trim()
  .max(120)
  .transform((s) => (s === '' ? null : s))
  .nullable();

const pincodeCreate = z
  .object({
    pincode: z
      .string()
      .transform((s, ctx) => {
        const p = normalizePincode(s);
        if (!p) ctx.addIssue({ code: 'custom', message: 'Must be a 6-digit pincode' });
        return p as string;
      }),
    deliveryWeekday: weekday,
    note: note.optional(),
    active: z.boolean().optional(),
  })
  .strict();

const pincodePatch = z
  .object({ deliveryWeekday: weekday, note, active: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field');

function idParam(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw new ApiError(404, 'not_found', 'Not found');
  return raw;
}

export function catalogRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/products', async (c) => c.json({ items: await listProducts(deps.db, c.get('tenant').id) }));

  r.post('/products', async (c) => {
    const body = await parseBody(c, productCreate);
    return c.json({ product: await createProduct(deps.db, c.get('tenant').id, body) }, 201);
  });

  r.patch('/products/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = await parseBody(c, productPatch);
    const product = await updateProduct(deps.db, c.get('tenant').id, id, patch);
    if (!product) throw new ApiError(404, 'not_found', 'Not found');
    return c.json({ product });
  });

  r.get('/pincodes', async (c) => c.json({ items: await listPincodes(deps.db, c.get('tenant').id) }));

  r.post('/pincodes', async (c) => {
    const body = await parseBody(c, pincodeCreate);
    return c.json({ pincode: await createPincode(deps.db, c.get('tenant').id, body) }, 201);
  });

  r.patch('/pincodes/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = await parseBody(c, pincodePatch);
    const pincode = await updatePincode(deps.db, c.get('tenant').id, id, patch);
    if (!pincode) throw new ApiError(404, 'not_found', 'Not found');
    return c.json({ pincode });
  });

  return r;
}
