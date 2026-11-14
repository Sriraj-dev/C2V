export const CLEANUP_JOB_NAME = 'purge-old-messages';
export const DEFAULT_RETENTION_DAYS = 3;

const MAX_DAYS = 3650;

function assertDays(days: number): void {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days must be an integer from 1 to ${MAX_DAYS}, got ${String(days)}`);
}

/** The `select cron.schedule(...)` statement. 21:30 UTC is 03:00 IST. Throws unless `days` is a positive integer. */
export function cleanupJobSql(days: number): string {
  assertDays(days);
  return `select cron.schedule('${CLEANUP_JOB_NAME}', '30 21 * * *', $$delete from messages where created_at < now() - interval '${days} days'$$)`;
}

/** Reads an optional `--days N` / `--days=N` from argv (default 3); throws on bad values or unknown args. */
export function parseDays(args: string[]): number {
  const usage = 'usage: db:schedule-cleanup [--days N]  (N: integer 1-3650, default 3)';
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--days') raw = args[++i];
    else if (a.startsWith('--days=')) raw = a.slice('--days='.length);
    else throw new Error(`unknown argument "${a}"; ${usage}`);
    if (raw === undefined || !/^\d{1,6}$/.test(raw)) throw new Error(`--days needs a positive integer; ${usage}`);
  }
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  assertDays(days);
  return days;
}
