import { describe, it, expect } from 'vitest';
import { normalizePincode } from '../../src/domain/pincode.js';

describe('normalizePincode', () => {
  it('strips whitespace from a valid pincode', () => {
    expect(normalizePincode(' 560 035 ')).toBe('560035');
  });
  it('rejects too short', () => {
    expect(normalizePincode('56003')).toBeNull();
  });
  it('rejects too long', () => {
    expect(normalizePincode('5600351')).toBeNull();
  });
  it('rejects non-numeric', () => {
    expect(normalizePincode('abcdef')).toBeNull();
  });
  it('rejects a leading zero', () => {
    expect(normalizePincode('060035')).toBeNull();
  });
});
