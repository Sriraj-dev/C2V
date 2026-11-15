/** Saved/order address phones are stored as 10 digits; a 12-digit query starting with 91 is the same number. */
export function localPhoneDigits(digits: string): string {
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}
