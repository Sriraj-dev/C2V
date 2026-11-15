import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { GraphWhatsAppSender } from './channels/whatsapp/sender.js';
import { createDbHandle } from './db/client.js';
import { loadEnv } from './config/env.js';
import { CashfreeProvider } from './payments/cashfree/client.js';
import { registerTenants } from './tenants/registry.js';
import { nutrifarm } from './tenants/nutrifarm/config.js';

const env = loadEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });
registerTenants([nutrifarm]);
const { db, close: closeDb } = createDbHandle(env.DATABASE_URL);
const app = buildApp({
  env,
  now: () => new Date(),
  log,
  db,
  whatsapp: new GraphWhatsAppSender(env),
  payments: new CashfreeProvider(env),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, 'server listening');
});

// Cloud Run sends SIGTERM before stopping an instance: stop accepting, drain the pool, exit.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) {
    log.warn({ signal }, 'second signal, exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // Cloud Run SIGKILLs ~10s after SIGTERM; force-exit just before that so the log line is reachable.
  setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 8_000).unref();
  server.close(() => {
    closeDb()
      .catch((err) => log.error({ err }, 'error closing db'))
      .finally(() => process.exit(0));
  });
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
