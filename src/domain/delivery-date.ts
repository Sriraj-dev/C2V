const IST_OFFSET_MS = 330 * 60_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Frequency = 'weekly' | 'biweekly' | 'monthly';

/** Parses YYYY-MM-DD into UTC parts, so the result never depends on the machine timezone. */
function parseIso(isoDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`Invalid ISO date: ${isoDate}`);
  return new Date(`${isoDate}T00:00:00Z`);
}

/** Returns the first date strictly after `now`'s IST calendar day that falls on `weekday` (0=Sun..6=Sat), as YYYY-MM-DD in IST. */
export function nextDeliveryDate(now: Date, weekday: number): string {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error(`weekday must be an integer 0-6, got ${weekday}`);
  }
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const today = ist.getUTCDay();
  const delta = ((weekday - today + 7) % 7) || 7;
  const todayIso = ist.toISOString().slice(0, 10);
  return addDays(todayIso, delta);
}

/** Formats YYYY-MM-DD as e.g. 'Wed, 18 Nov'. */
export function formatDeliveryDate(isoDate: string): string {
  const d = parseIso(isoDate);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Adds (possibly negative) whole days to a YYYY-MM-DD date using UTC math. */
export function addDays(isoDate: string, days: number): string {
  const d = parseIso(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function frequencyStepDays(f: Frequency): 7 | 14 | 28 {
  switch (f) {
    case 'weekly':
      return 7;
    case 'biweekly':
      return 14;
    case 'monthly':
      return 28;
  }
}
