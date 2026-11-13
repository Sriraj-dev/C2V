import { Hono } from 'hono';
import type { AppDeps } from './deps.js';

export function buildApp(_deps: AppDeps): Hono {
  const app = new Hono();
  // Must not touch the database.
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
