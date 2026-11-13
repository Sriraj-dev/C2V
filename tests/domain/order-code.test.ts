import { describe, it, expect } from 'vitest';
import { generateOrderCode } from '../../src/domain/order-code.js';

describe('generateOrderCode', () => {
  it('produces prefix-plus-6 chars from the unambiguous alphabet', () => {
    expect(generateOrderCode('NF')).toMatch(/^NF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
  it('maps bytes onto the alphabet deterministically with an injected source', () => {
    // alphabet index: 0=A, 1=B, 2=C, 24=2, 31=9, 32 wraps to 0=A
    const random = (n: number) => {
      expect(n).toBe(6);
      return Uint8Array.from([0, 1, 2, 24, 31, 32]);
    };
    expect(generateOrderCode('NF', random)).toBe('NF-ABC29A');
  });
});
