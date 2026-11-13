import { Hono } from 'hono';
import { handleInbound } from './bot/router.js';
import type { InboundMessage } from './channels/whatsapp/parse.js';
import type { AppDeps } from './deps.js';
import { whatsappRoutes } from './ingress/whatsapp-routes.js';
import type { TenantConfig } from './tenants/types.js';

export interface AppOpts {
  onInbound?: (tenant: TenantConfig, msg: InboundMessage) => Promise<void>;
}

export function buildApp(deps: AppDeps, opts: AppOpts = {}): Hono {
  const app = new Hono();
  // Must not touch the database.
  app.get('/health', (c) => c.json({ ok: true }));
  const onInbound = opts.onInbound ?? ((tenant, msg) => handleInbound(deps, tenant, msg));
  app.route('/', whatsappRoutes(deps, onInbound));
  return app;
}
