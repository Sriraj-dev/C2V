import { describe, it, expect } from 'vitest';
import { newToken, sha256Hex } from '../../../src/admin/auth/tokens.js';

describe('tokens', () => {
  it('newToken is 43 base64url chars and unique', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('sha256Hex matches the known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
