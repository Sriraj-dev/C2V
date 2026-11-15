import { describe, it, expect } from 'vitest';
import { normalizeIndianPhone } from '../../src/domain/phone.js';

describe('normalizeIndianPhone', () => {
  it('normalizes valid numbers', () => {
    expect(normalizeIndianPhone('9398651343')).toBe('919398651343');
    expect(normalizeIndianPhone('+91 93986-51343')).toBe('919398651343');
    expect(normalizeIndianPhone('919398651343')).toBe('919398651343');
  });
  it('rejects invalid numbers', () => {
    expect(normalizeIndianPhone('12345')).toBeNull();
    expect(normalizeIndianPhone('5398651343')).toBeNull();
    expect(normalizeIndianPhone('915398651343')).toBeNull();
  });
});
