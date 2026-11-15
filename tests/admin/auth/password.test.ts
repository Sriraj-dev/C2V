import { describe, it, expect } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../../../src/admin/auth/password.js';

describe('password', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('salts: two hashes of the same password differ', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false for malformed stored values', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('uses the documented hash format', async () => {
    expect(await hashPassword('p')).toMatch(/^scrypt\$16384\$8\$1\$/);
  });

  it('generatePassword is 16 chars from the allowed alphabet', () => {
    const p = generatePassword();
    expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/);
  });
});
