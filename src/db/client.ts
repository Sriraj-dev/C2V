import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

/** Drizzle instance; satisfied by both postgres-js (prod) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Db plus a `close` that drains the connection pool (used for graceful shutdown). */
export function createDbHandle(url: string): { db: Db; close: () => Promise<void> } {
  // prepare: false is required for the Supabase transaction pooler.
  const client = postgres(url, { prepare: false, max: 5 });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export function createDb(url: string): Db {
  return createDbHandle(url).db;
}
