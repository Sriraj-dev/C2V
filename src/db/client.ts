import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

/** Drizzle instance; satisfied by both postgres-js (prod) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): Db {
  // prepare: false is required for the Supabase transaction pooler.
  const client = postgres(url, { prepare: false, max: 5 });
  return drizzle(client, { schema });
}
