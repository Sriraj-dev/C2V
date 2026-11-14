/**
 * Schedules the message-retention purge as a Supabase pg_cron job. Run once per environment:
 *   pnpm db:schedule-cleanup [--days N]      (default 3)
 * Re-running is safe: an existing 'purge-old-messages' job is replaced.
 *
 * This is a script, not a migration, because PGlite (used by the tests) has no pg_cron extension.
 * Retention is global, not per tenant: tenant.messageRetentionDays is NOT consulted here.
 * Per-tenant retention is a future need.
 *
 * Run it as the postgres role (Supabase direct or pooler connection as postgres): other roles cannot create
 * the extension, and jobs are owned by the connecting role.
 *
 * The schedule is 21:30 UTC daily, which is 03:00 IST.
 */
import postgres from 'postgres';
import { CLEANUP_JOB_NAME, cleanupJobSql, parseDays } from './lib/cleanup-sql.js';

const days = parseDays(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql`create extension if not exists pg_cron`;
  await sql`select cron.unschedule(jobid) from cron.job where jobname = ${CLEANUP_JOB_NAME}`;
  await sql.unsafe(cleanupJobSql(days));
  const rows = await sql`select jobid, jobname, schedule, command, active from cron.job where jobname = ${CLEANUP_JOB_NAME}`;
  console.table(rows);
} finally {
  await sql.end();
}
