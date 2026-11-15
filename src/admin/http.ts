import type { Context } from 'hono';
import type { Logger } from 'pino';
import { z } from 'zod';
import { WhatsAppSendError } from '../channels/whatsapp/sender.js';
import { errInfo } from '../bot/log.js';
import type { VendorSessionRow, VendorUserRow } from '../db/schema.js';
import {
  InvalidTransitionError,
  NotSupportedError,
  OrderNotFoundError,
  PartnerUnavailableError,
  RefundNotPossibleError,
} from '../orders/order-status.js';
import { ProviderError } from '../payments/provider.js';
import type { TenantConfig } from '../tenants/types.js';

/** Hono env for authenticated vendor routes: `c.get('tenant')` etc. are typed. */
export type AdminEnv = { Variables: { tenant: TenantConfig; vendor: VendorUserRow; session: VendorSessionRow } };

export type ApiStatus = 400 | 401 | 404 | 409 | 422 | 502;

export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null | undefined)?.code;
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505';
}

/** Maps known domain/provider errors to an ApiError; null for anything unexpected. */
export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof OrderNotFoundError) return new ApiError(404, 'not_found', 'Not found');
  if (err instanceof InvalidTransitionError) return new ApiError(409, 'invalid_transition', err.message);
  if (err instanceof NotSupportedError) return new ApiError(422, 'not_supported', err.message);
  if (err instanceof PartnerUnavailableError) return new ApiError(409, 'partner_unavailable', err.message);
  if (err instanceof RefundNotPossibleError) return new ApiError(409, 'refund_not_possible', err.message);
  if (err instanceof ProviderError) return new ApiError(502, 'provider_error', err.message);
  if (err instanceof WhatsAppSendError) return new ApiError(502, 'provider_error', 'WhatsApp request failed');
  if (isUniqueViolation(err)) return new ApiError(409, 'conflict', 'That value is already in use');
  return null;
}

export function errorResponse(c: Context, err: unknown, log: Logger): Response {
  const api = toApiError(err);
  if (!api) {
    log.error({ err: errInfo(err), path: c.req.path.replace(/\/partner\/[^/]*/, '/partner/[redacted]') }, 'admin request failed');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  }
  const error: { code: string; message: string; details?: unknown } = { code: api.code, message: api.message };
  if (api.details !== undefined) error.details = api.details;
  return c.json({ error }, api.status);
}

function validationError(err: z.ZodError): ApiError {
  const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return new ApiError(400, 'validation_error', 'Invalid request', details);
}

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'validation_error', 'Request body must be valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export const pageParams = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function paged<T>(items: T[], page: number, pageSize: number, total: number) {
  return { items, page, pageSize, total };
}
