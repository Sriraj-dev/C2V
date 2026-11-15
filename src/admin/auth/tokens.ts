import { createHash, randomBytes } from 'node:crypto';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
