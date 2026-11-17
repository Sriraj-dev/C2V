import type { Context, MiddlewareHandler } from 'hono';
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

export type ApiStatus = 400 | 401 | 404 | 409 | 422 | 502 | 503;

/** Admin and partner requests give up after this long (the Supabase pooler ignores a per-connection statement_timeout). */
export const REQUEST_TIMEOUT_MS = 15_000;

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

/** The error's `code`, or its cause's (drizzle wraps driver errors as `cause`). */
function errCodes(err: unknown): unknown[] {
  const code = (e: unknown) => (e as { code?: unknown } | null | undefined)?.code;
  return [code(err), code((err as { cause?: unknown } | null)?.cause)];
}

function isUniqueViolation(err: unknown): boolean {
  return errCodes(err).includes('23505');
}

/** Statement cancelled (57014) or the connection to the database failed: worth retrying shortly. */
const DB_UNAVAILABLE_CODES = new Set<unknown>([
  '57014',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

/** node-postgres reports pool/connection failures by message only (no code). */
const DB_UNAVAILABLE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated',
  'Client has encountered a connection error',
];

function isDbUnavailable(err: unknown): boolean {
  if (errCodes(err).some((c) => DB_UNAVAILABLE_CODES.has(c))) return true;
  const msg = (e: unknown) => (e instanceof Error ? e.message : '');
  const messages = [msg(err), msg((err as { cause?: unknown } | null)?.cause)];
  return messages.some((m) => DB_UNAVAILABLE_MESSAGES.some((known) => m.startsWith(known)));
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
  if (isDbUnavailable(err)) return new ApiError(503, 'db_unavailable', 'Database is temporarily unavailable; try again');
  return null;
}

export function errorResponse(c: Context, err: unknown, log: Logger): Response {
  const api = toApiError(err);
  const path = c.req.path.replace(/\/partner\/[^/]*/, '/partner/[redacted]');
  if (!api) {
    log.error({ err: errInfo(err), path }, 'admin request failed');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  }
  if (api.status === 503) log.warn({ err: errInfo(err), path, code: api.code }, 'admin request unavailable');
  const error: { code: string; message: string; details?: unknown } = { code: api.code, message: api.message };
  if (api.details !== undefined) error.details = api.details;
  return c.json({ error }, api.status);
}

/**
 * Fails the request with 503 `timeout` if the handler takes longer than `ms`. The handler keeps running
 * in the background, so a write may still complete; clients should reload before retrying.
 */
export function requestTimeout(ms: number): MiddlewareHandler {
  return async (_c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(503, 'timeout', 'The request took too long; reload and try again')), ms);
    });
    try {
      await Promise.race([next(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
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
