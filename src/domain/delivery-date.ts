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

/** Full weekday name for 0 (Sunday) to 6 (Saturday); falls back to 'day'. */
export function weekdayName(weekday: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday] ?? 'day';
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

/** Weekday occurrences closer than this many days after activation are too soon to charge on D-2. */
const MIN_LEAD_DAYS = 2;
/** On activation exactly MIN_LEAD_DAYS before a delivery, the D-2 charge must be raised before 21:00; cut off at 20:00. */
const LATE_ACTIVATION_HOUR_IST = 20;

/**
 * First subscription delivery (spec §10 "First delivery"): the first `weekday` (0=Sun..6=Sat) at least 2 days after
 * `now`'s IST day; if that date is exactly 2 days away and `now` is at or after 20:00 IST, the one a week later.
 */
export function firstSubscriptionDelivery(now: Date, weekday: number): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const todayIso = ist.toISOString().slice(0, 10);
  let first = nextDeliveryDate(new Date(`${addDays(todayIso, MIN_LEAD_DAYS - 1)}T12:00:00+05:30`), weekday);
  if (first === addDays(todayIso, MIN_LEAD_DAYS) && ist.getUTCHours() >= LATE_ACTIVATION_HOUR_IST) {
    first = addDays(first, 7);
  }
  return first;
}

/** e.g. 'every Wednesday', 'every 2 weeks on Wednesday', 'every 4 weeks on Wednesday'. */
export function frequencyLabel(f: Frequency, weekday: number): string {
  const day = weekdayName(weekday);
  switch (f) {
    case 'weekly':
      return `every ${day}`;
    case 'biweekly':
      return `every 2 weeks on ${day}`;
    case 'monthly':
      return `every 4 weeks on ${day}`;
  }
}

/** `now`'s IST calendar day as YYYY-MM-DD. */
export function istToday(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
