import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verifies `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 of the raw body). */
export function verifyMetaSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  if (!/^[0-9a-fA-F]{64}$/.test(given)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}
