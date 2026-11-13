/** Formats an integer paise amount as rupees with Indian digit grouping, e.g. 123456 -> '₹1,234.56'. */
export function formatPaise(p: number): string {
  if (!Number.isInteger(p)) throw new Error(`formatPaise expects integer paise, got ${p}`);
  const abs = Math.abs(p);
  const rupees = String(Math.floor(abs / 100));
  const paise = abs % 100;
  const grouped =
    rupees.length <= 3
      ? rupees
      : rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + rupees.slice(-3);
  const body = paise === 0 ? grouped : `${grouped}.${String(paise).padStart(2, '0')}`;
  return `${p < 0 ? '-' : ''}₹${body}`;
}
