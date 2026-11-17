import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Logger } from 'pino';
import * as schema from './schema.js';

/** Drizzle instance; satisfied by both node-postgres (prod) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Db plus a `close` that drains the connection pool (used for graceful shutdown).
 *
 * Uses node-postgres, not postgres.js: postgres.js pipelines extra queries onto busy connections,
 * and the Supabase transaction pooler (Supavisor, :6543) loses the replies to pipelined queries,
 * which left connections waiting forever. node-postgres runs one query per connection at a time;
 * extra queries wait in the pool for a free connection.
 */
export function createDbHandle(url: string, log?: Logger): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 10_000, // fail if no connection can be made or borrowed in 10s
    idleTimeoutMillis: 20_000, // close connections idle for 20s
    maxLifetimeSeconds: 30 * 60, // replace connections after 30 min
  });
  // An idle connection dropped by the pooler emits 'error' on the pool; without a listener it crashes the process.
  pool.on('error', (err) => log?.warn({ err: { message: err.message } }, 'idle database connection dropped'));
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export function createDb(url: string): Db {
  return createDbHandle(url).db;
}
