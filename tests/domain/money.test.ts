import { describe, it, expect } from 'vitest';
import { formatPaise } from '../../src/domain/money.js';

describe('formatPaise', () => {
  it('formats whole rupees without decimals', () => {
    expect(formatPaise(48000)).toBe('₹480');
  });
  it('formats fractional amounts with two decimals', () => {
    expect(formatPaise(123456)).toBe('₹1,234.56');
  });
  it('formats zero', () => {
    expect(formatPaise(0)).toBe('₹0');
  });
  it('pads small and trailing-zero paise', () => {
    expect(formatPaise(5)).toBe('₹0.05');
    expect(formatPaise(100050)).toBe('₹1,000.50');
  });
  it('uses Indian lakh grouping', () => {
    expect(formatPaise(12345600)).toBe('₹1,23,456');
  });
});
