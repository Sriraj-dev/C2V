import { describe, expect, it } from 'vitest';
import { cleanupJobSql, parseDays } from '../../scripts/lib/cleanup-sql.js';

describe('cleanupJobSql', () => {
  it('schedules the purge at 21:30 UTC with the given interval', () => {
    const sql = cleanupJobSql(3);
    expect(sql).toContain("cron.schedule('purge-old-messages', '30 21 * * *'");
    expect(sql).toContain("delete from messages where created_at < now() - interval '3 days'");
  });
  it('uses the supplied days', () => {
    expect(cleanupJobSql(7)).toContain("interval '7 days'");
  });
  it.each([0, -1, 1.5, NaN, Infinity, 3651, 1e21])('rejects invalid days %s', (d) => {
    expect(() => cleanupJobSql(d)).toThrow();
  });
});

describe('parseDays', () => {
  it('defaults to 3', () => expect(parseDays([])).toBe(3));
  it('reads --days=N', () => expect(parseDays(['--days=9'])).toBe(9));
  it('rejects unknown args', () => expect(() => parseDays(['--day', '7'])).toThrow(/usage/));
  it('rejects huge values', () => expect(() => parseDays(['--days', '1000000000000000000000'])).toThrow());
  it('reads --days N', () => expect(parseDays(['--days', '7'])).toBe(7));
  it.each([['--days'], ['--days', 'abc'], ['--days', '0'], ['--days', '2.5'], ['--days', '-3']])('rejects %j', (...a) => {
    expect(() => parseDays(a as string[])).toThrow();
  });
});
