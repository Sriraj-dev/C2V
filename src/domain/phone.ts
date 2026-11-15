/** Normalizes an Indian mobile number to `91XXXXXXXXXX`, or null if invalid. */
export function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+/, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}
