import { Hono } from 'hono';
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
  // Until Task 7 wires the bot, inbound messages are only logged.
  const onInbound =
    opts.onInbound ??
    (async (tenant, msg) => {
      deps.log.info(
        { tenantId: tenant.id, kind: msg.kind, waMessageId: msg.waMessageId },
        'inbound message',
      );
    });
  app.route('/', whatsappRoutes(deps, onInbound));
  return app;
}
