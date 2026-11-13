import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { GraphWhatsAppSender } from './channels/whatsapp/sender.js';
import { createDb } from './db/client.js';
import { loadEnv } from './config/env.js';
import { registerTenants } from './tenants/registry.js';
import { nutrifarm } from './tenants/nutrifarm/config.js';

const env = loadEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });
registerTenants([nutrifarm]);
const app = buildApp({
  env,
  now: () => new Date(),
  log,
  db: createDb(env.DATABASE_URL),
  whatsapp: new GraphWhatsAppSender(env),
  payments: undefined,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, 'server listening');
});
