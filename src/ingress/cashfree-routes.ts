import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { errInfo } from '../bot/log.js';
import { subscriptions } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { confirmPaidOrder } from '../orders/checkout.js';
import { parseCashfreeEvent, verifyCashfreeSignature } from '../payments/cashfree/webhook.js';
import { findPaymentByProviderRef } from '../payments/payment-repo.js';
import { tenantById } from '../tenants/registry.js';

export function cashfreeRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Unauthenticated endpoint: cap the body before buffering it (Cashfree payloads are a few KB).
  app.post('/webhooks/cashfree', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('payload too large', 413) }), async (c) => {
    // The signature covers the exact bytes Cashfree sent, so verify against the raw text, never re-serialised JSON.
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text('invalid json', 400);
    }
    const event = parseCashfreeEvent(body);
    if (event.type === 'ignored') {
      deps.log.info({ event: event.raw }, 'cashfree webhook ignored');
      return c.text('ok', 200);
    }

    try {
      // The tenant (and so the secret) is whichever tenant owns the referenced link/subscription.
      let tenantId: string | undefined;
      if (event.type === 'link_paid' || event.type === 'link_status') {
        tenantId = (await findPaymentByProviderRef(deps.db, undefined, event.linkId))?.tenantId;
      } else if (event.type === 'subscription_status' || event.type === 'subscription_charge') {
        // The webhook's subscription_id is our subscriptions.id (a uuid); anything else is unknown (and would make Postgres throw).
        if (UUID_RE.test(event.subscriptionId)) {
          const [sub] = await deps.db
            .select({ tenantId: subscriptions.tenantId })
            .from(subscriptions)
            .where(eq(subscriptions.id, event.subscriptionId))
            .limit(1);
          tenantId = sub?.tenantId;
        }
      }
      if (!tenantId) {
        deps.log.warn({ type: event.type }, 'cashfree webhook for unknown reference');
        return c.text('ok', 200);
      }
      const tenant = tenantById(tenantId);
      if (!tenant) {
        deps.log.warn({ tenantId, type: event.type }, 'cashfree webhook for unregistered tenant');
        return c.text('ok', 200);
      }

      const secret = process.env[tenant.cashfree.secretEnv] ?? '';
      if (!verifyCashfreeSignature(raw, c.req.header('x-webhook-timestamp'), c.req.header('x-webhook-signature'), secret)) {
        deps.log.warn({ tenantId, type: event.type }, 'cashfree webhook signature invalid');
        return c.text('invalid signature', 401);
      }

      if (event.type === 'link_paid' || event.type === 'link_status') {
        const result = await confirmPaidOrder(deps, tenant, event.linkId);
        deps.log.info({ tenantId, type: event.type, result }, 'cashfree link event handled');
      } else {
        // Subscription handlers arrive with Task 14.
        deps.log.info({ tenantId, type: event.type }, 'cashfree subscription event received');
      }
    } catch (err) {
      // Always ack after a verified-or-unverifiable handler failure so Cashfree does not retry forever; the daily job reconciles.
      deps.log.error({ type: event.type, err: errInfo(err) }, 'cashfree webhook handler failed');
    }
    return c.text('ok', 200);
  });

  return app;
}
