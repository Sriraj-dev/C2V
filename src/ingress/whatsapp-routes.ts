import { Hono } from 'hono';
import { parseWebhook, type InboundMessage } from '../channels/whatsapp/parse.js';
import { verifyMetaSignature } from '../channels/whatsapp/signature.js';
import type { AppDeps } from '../deps.js';
import { tenantByPhoneNumberId } from '../tenants/registry.js';
import type { TenantConfig } from '../tenants/types.js';

export type OnInbound = (tenant: TenantConfig, msg: InboundMessage) => Promise<void>;

export function whatsappRoutes(deps: AppDeps, onInbound: OnInbound): Hono {
  const app = new Hono();

  app.get('/webhooks/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token === deps.env.META_VERIFY_TOKEN && challenge !== undefined) {
      return c.text(challenge, 200);
    }
    return c.text('forbidden', 403);
  });

  app.post('/webhooks/whatsapp', async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256'), deps.env.META_APP_SECRET)) {
      return c.text('invalid signature', 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return c.text('invalid json', 400);
    }
    for (const msg of parseWebhook(body, (info) => deps.log.warn(info, 'dropped invalid webhook message'))) {
      const tenant = tenantByPhoneNumberId(msg.phoneNumberId);
      if (!tenant) {
        deps.log.warn({ phoneNumberId: msg.phoneNumberId }, 'webhook for unknown phone number id');
        continue;
      }
      try {
        await onInbound(tenant, msg);
      } catch (err) {
        // Always ack: a non-200 makes Meta retry the delivery indefinitely.
        deps.log.error(
          { err, tenantId: tenant.id, waMessageId: msg.waMessageId },
          'inbound handler failed',
        );
      }
    }
    return c.text('ok', 200);
  });

  return app;
}
