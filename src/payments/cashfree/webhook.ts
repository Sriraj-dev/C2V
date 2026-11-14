import { createHmac, timingSafeEqual } from 'node:crypto';

export type CashfreeEvent =
  | { type: 'link_paid' | 'link_status'; linkId: string; linkStatus?: string }
  | { type: 'subscription_status'; subscriptionId: string; status: string }
  | { type: 'subscription_charge'; subscriptionId: string; paymentId: string; success: boolean }
  | { type: 'ignored'; raw: string };

/** signature = base64(HMAC_SHA256(timestamp + rawBody, clientSecret)); constant-time compare, never throws. */
export function verifyCashfreeSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  try {
    if (!timestamp || !signature || !secret || typeof rawBody !== 'string') return false;
    // Compare the base64 text itself: Buffer's base64 decoder is lenient (it ignores trailing data after padding).
    const expected = Buffer.from(createHmac('sha256', secret).update(timestamp + rawBody).digest('base64'));
    const given = Buffer.from(signature);
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

function ignored(body: unknown): CashfreeEvent {
  const type = str(rec(body)?.type);
  return { type: 'ignored', raw: (type ? `type=${type}` : typeof body).slice(0, 80) };
}

/** Never throws. Anything unknown or malformed becomes `{ type: 'ignored' }` with a short, PII-free `raw`. */
export function parseCashfreeEvent(body: unknown): CashfreeEvent {
  try {
    const b = rec(body);
    const data = rec(b?.data);
    if (!b || !data) return ignored(body);
    switch (b.type) {
      case 'PAYMENT_LINK_EVENT': {
        const linkId = str(data.link_id);
        if (!linkId) return ignored(body);
        const linkStatus = str(data.link_status);
        return { type: linkStatus === 'PAID' ? 'link_paid' : 'link_status', linkId, ...(linkStatus ? { linkStatus } : {}) };
      }
      case 'SUBSCRIPTION_STATUS_CHANGED':
      case 'SUBSCRIPTION_AUTH_STATUS': {
        const sub = rec(data.subscription_details);
        const subscriptionId = str(sub?.subscription_id) ?? str(data.subscription_id);
        const status = str(sub?.subscription_status) ?? str(rec(data.authorization_details)?.authorization_status);
        if (!subscriptionId || !status) return ignored(body);
        return { type: 'subscription_status', subscriptionId, status };
      }
      case 'SUBSCRIPTION_PAYMENT_SUCCESS':
      case 'SUBSCRIPTION_PAYMENT_FAILED': {
        const subscriptionId = str(data.subscription_id) ?? str(rec(data.subscription_details)?.subscription_id);
        const paymentId = str(data.payment_id) ?? str(data.cf_payment_id);
        if (!subscriptionId || !paymentId) return ignored(body);
        return { type: 'subscription_charge', subscriptionId, paymentId, success: b.type === 'SUBSCRIPTION_PAYMENT_SUCCESS' };
      }
      default:
        return ignored(body);
    }
  } catch {
    return { type: 'ignored', raw: 'unparseable' };
  }
}
