import type { Env } from '../../config/env.js';
import type { TenantConfig } from '../../tenants/types.js';
import type { CreatePaymentLinkInput, LinkStatus, PaymentProvider } from '../provider.js';

const API_VERSION = '2026-01-01';
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_URLS = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
} as const;
const LINK_STATUSES: readonly string[] = ['ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED', 'PARTIALLY_PAID'];
const IST_OFFSET_MS = 330 * 60_000;

/** Error from Cashfree or from reaching it. Messages never contain credentials or customer details. */
export class CashfreeError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for timeouts, network failures and local errors. */
    readonly status: number,
    /** Cashfree's `code` field, when present. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CashfreeError';
  }
}

export class InvalidCustomerPhoneError extends CashfreeError {
  constructor() {
    super('Customer phone is not a valid 10-digit Indian mobile number', 0, 'invalid_customer_phone');
    this.name = 'InvalidCustomerPhoneError';
  }
}

/** Normalises '+91 98765 43210', '919876543210', '09876543210' etc. to 10 digits; throws if not a valid Indian mobile. */
export function normalizeIndianPhone(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new InvalidCustomerPhoneError();
  return d;
}

/** Integer paise -> rupees number, computed without float drift (48000 -> 480, 12345 -> 123.45). */
export function paiseToRupees(paise: number): number {
  if (!Number.isInteger(paise) || paise <= 0) throw new CashfreeError('Amount must be a positive integer number of paise', 0, 'invalid_amount');
  return Number(`${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`);
}

/** Rupees (number or numeric string) -> integer paise. */
export function rupeesToPaise(rupees: unknown): number {
  const n = typeof rupees === 'string' ? Number(rupees) : rupees;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** ISO 8601 with an explicit +05:30 offset, e.g. 2026-04-30T23:59:59+05:30. */
export function toIstIso(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

export class CashfreeProvider implements PaymentProvider {
  constructor(
    private readonly env: Pick<Env, 'CASHFREE_ENV'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createPaymentLink(t: TenantConfig, i: CreatePaymentLinkInput): Promise<{ linkId: string; url: string }> {
    const customer_details: Record<string, string> = { customer_phone: normalizeIndianPhone(i.customerPhone) };
    const name = (i.customerName ?? '').trim().slice(0, 100).trim();
    if (name) customer_details.customer_name = name;
    const body = {
      link_id: i.linkId,
      link_amount: paiseToRupees(i.amountPaise),
      link_currency: 'INR',
      link_purpose: i.purpose.slice(0, 500),
      customer_details,
      link_expiry_time: toIstIso(i.expiresAt),
      link_notify: { send_sms: false, send_email: false },
      link_auto_reminders: false,
      link_partial_payments: false,
      // upi_intent must be a JSON boolean (sandbox rejects the string "true" the docs show).
      link_meta: { notify_url: i.notifyUrl, upi_intent: true },
    };
    let res;
    try {
      // Idempotency key makes a retry after a lost response return the same link.
      res = await this.call(t, 'POST', '/links', body, { 'x-idempotency-key': `link:${i.linkId}` });
    } catch (e) {
      if (!(e instanceof CashfreeError && e.status === 409 && e.code === 'link_already_exists')) throw e;
      // Created earlier (e.g. response lost): reuse it only if it is still live and for the same amount.
      const existing = await this.call(t, 'GET', `/links/${encodeURIComponent(i.linkId)}`);
      const existingUrl = typeof existing.link_url === 'string' ? existing.link_url : '';
      if (existing.link_status === 'ACTIVE' && rupeesToPaise(existing.link_amount) === i.amountPaise && existingUrl) {
        return { linkId: i.linkId, url: existingUrl };
      }
      throw e;
    }
    const url = typeof res.link_url === 'string' ? res.link_url : '';
    if (!url) throw new CashfreeError('Cashfree response missing link_url', 0, 'bad_response');
    return { linkId: typeof res.link_id === 'string' ? res.link_id : i.linkId, url };
  }

  async getPaymentLink(t: TenantConfig, linkId: string): Promise<{ status: LinkStatus; amountPaidPaise: number }> {
    const res = await this.call(t, 'GET', `/links/${encodeURIComponent(linkId)}`);
    const status = String(res.link_status);
    if (!LINK_STATUSES.includes(status)) throw new CashfreeError('Cashfree returned an unknown link_status', 0, 'bad_response');
    const paid = typeof res.link_amount_paid === 'string' && res.link_amount_paid.trim() ? Number(res.link_amount_paid) : res.link_amount_paid;
    if (typeof paid !== 'number' || !Number.isFinite(paid) || paid < 0) {
      throw new CashfreeError('Cashfree returned an invalid link_amount_paid', 0, 'bad_response');
    }
    return { status: status as LinkStatus, amountPaidPaise: rupeesToPaise(paid) };
  }

  async cancelPaymentLink(t: TenantConfig, linkId: string): Promise<void> {
    await this.call(t, 'POST', `/links/${encodeURIComponent(linkId)}/cancel`);
  }

  /** Retrying with the same refundId and amount is safe; a different amount for the same refundId surfaces Cashfree's `refund_id_already_exists` code. */
  async refundPaymentLink(t: TenantConfig, linkId: string, amountPaise: number, refundId: string): Promise<void> {
    const refundAmount = paiseToRupees(amountPaise);
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(refundId)) throw new CashfreeError('refund_id must be 3-40 characters of [A-Za-z0-9_-]', 0, 'invalid_refund_id');
    const listed = await this.call(t, 'GET', `/links/${encodeURIComponent(linkId)}/orders?status=PAID`);
    const orders = Array.isArray(listed) ? listed : Array.isArray(listed.data) ? listed.data : [];
    const paid = orders.filter((o: unknown): o is { order_id: string; order_amount?: unknown } => isRecord(o) && typeof o.order_id === 'string');
    if (paid.length === 0) throw new CashfreeError('No PAID order found for payment link', 0, 'no_paid_order');
    let chosen = paid[0]!;
    if (paid.length > 1) {
      const matching = paid.filter((o: { order_amount?: unknown }) => rupeesToPaise(o.order_amount) === amountPaise);
      if (matching.length !== 1) throw new CashfreeError('Payment link has several PAID orders; cannot pick one to refund', 0, 'ambiguous_paid_orders');
      chosen = matching[0]!;
    }
    await this.call(t, 'POST', `/orders/${encodeURIComponent(chosen.order_id)}/refunds`, {
      refund_amount: refundAmount,
      refund_id: refundId,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(t: TenantConfig, method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
    const clientId = process.env[t.cashfree.appIdEnv];
    const clientSecret = process.env[t.cashfree.secretEnv];
    if (!clientId || !clientSecret) {
      throw new CashfreeError(`Cashfree credentials not configured (${t.cashfree.appIdEnv}/${t.cashfree.secretEnv})`, 0, 'missing_credentials');
    }
    const headers: Record<string, string> = {
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
      'x-api-version': API_VERSION,
      ...extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URLS[this.env.CASHFREE_ENV]}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new CashfreeError(timedOut ? 'Cashfree request timed out' : 'Cashfree network error', 0, timedOut ? 'timeout' : 'network_error');
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const code = isRecord(json) && typeof json.code === 'string' ? json.code : undefined;
      // Cashfree's free text can echo request values (phone, name): cap it and mask long digit runs.
      const msg = (isRecord(json) && typeof json.message === 'string' ? json.message : 'request failed').slice(0, 200).replace(/\d{10,}/g, '***');
      throw new CashfreeError(`Cashfree ${res.status}${code ? ` ${code}` : ''}: ${msg}`, res.status, code);
    }
    return json ?? {};
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
