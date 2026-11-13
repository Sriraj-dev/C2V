import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyMetaSignature } from '../../../src/channels/whatsapp/signature.js';

const secret = 's3cret';
const body = '{"a":1}';
const sig = (b: string) => 'sha256=' + createHmac('sha256', secret).update(b).digest('hex');

describe('verifyMetaSignature', () => {
  it('accepts a valid signature', () => {
    expect(verifyMetaSignature(body, sig(body), secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyMetaSignature('{"a":2}', sig(body), secret)).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
  });
  it('rejects wrong secret, bad prefix, and bad length/hex', () => {
    expect(verifyMetaSignature(body, sig(body), 'other')).toBe(false);
    expect(verifyMetaSignature(body, sig(body).replace('sha256=', 'sha1='), secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abcd', secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=' + 'zz'.repeat(32), secret)).toBe(false);
  });
});
