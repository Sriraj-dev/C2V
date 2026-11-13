const PINCODE = /^[1-9][0-9]{5}$/;

/** Strips all whitespace and returns the 6-digit Indian pincode, or null if invalid. */
export function normalizePincode(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, '');
  return PINCODE.test(cleaned) ? cleaned : null;
}
