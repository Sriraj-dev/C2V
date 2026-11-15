import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';

describe('row level security', () => {
  it('is enabled on every public table (Supabase exposes public to the Data API)', async () => {
    const db = await createTestDb();
    const res = await db.execute<{ relname: string; relrowsecurity: boolean }>(
      sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname not like '\\_\\_drizzle%'`,
    );
    const rows = (res as unknown as { rows: { relname: string; relrowsecurity: boolean }[] }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });
});
