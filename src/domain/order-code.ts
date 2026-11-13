// 32 characters, so `byte % 32` is unbiased. Omits look-alikes (0, 1, I, O).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const defaultRandom = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Generates `<prefix>-XXXXXX`, e.g. 'NF-K7M2QD'. */
export function generateOrderCode(
  prefix: string,
  random: (n: number) => Uint8Array = defaultRandom,
): string {
  const bytes = random(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return `${prefix}-${code}`;
}
