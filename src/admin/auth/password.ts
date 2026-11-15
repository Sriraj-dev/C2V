import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEY_LEN, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(plain, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [n, r, p] = [parts[1], parts[2], parts[3]].map(Number);
    if (![n, r, p].every((v) => Number.isInteger(v) && v! > 0)) return false;
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length === 0 || expected.length !== KEY_LEN) return false;
    const actual = await derive(plain, salt, n!, r!, p!);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function generatePassword(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
