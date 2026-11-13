import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });
const app = buildApp({
  env,
  now: () => new Date(),
  log,
  db: undefined,
  whatsapp: undefined,
  payments: undefined,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, 'server listening');
});
