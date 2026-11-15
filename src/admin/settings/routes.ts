import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { normalizeIndianPhone } from '../../domain/phone.js';
import { getTenantSettings, updateTenantSettings } from '../../tenants/settings-repo.js';
import { parseBody, type AdminEnv } from '../http.js';

const paise = z.number().int().min(0).max(10_000_000);

const patchBody = z
  .object({
    supportPhone: z
      .string()
      .trim()
      .transform((s, ctx) => {
        const p = normalizeIndianPhone(s);
        if (!p) ctx.addIssue({ code: 'custom', message: 'Invalid Indian mobile number' });
        return p as string;
      })
      .nullable(),
    welcomeImageUrl: z
      .string()
      .trim()
      .max(2000)
      .refine((s) => {
        try {
          return new URL(s).protocol === 'https:';
        } catch {
          return false;
        }
      }, 'Must be an https URL')
      .nullable(),
    deliveryFeePaise: paise,
    minOrderPaise: paise,
  })
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Provide at least one field');

export function settingsRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/settings', async (c) => c.json({ settings: await getTenantSettings(deps.db, c.get('tenant').id) }));

  r.patch('/settings', async (c) => {
    const patch = await parseBody(c, patchBody);
    return c.json({ settings: await updateTenantSettings(deps.db, c.get('tenant').id, patch) });
  });

  return r;
}
