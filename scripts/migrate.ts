import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const client = postgres(url, { prepare: false, max: 1 });
await migrate(drizzle(client), { migrationsFolder: 'src/db/migrations' });
await client.end();
console.log('migrations applied');
