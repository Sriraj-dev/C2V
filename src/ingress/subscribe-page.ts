import { Hono, type Context } from 'hono';
import { errInfo } from '../bot/log.js';
import type { AppDeps } from '../deps.js';
import { AUTH_TOKEN_RE, findSubscriptionByAuthToken } from '../subscriptions/subscription-repo.js';
import { tenantById } from '../tenants/registry.js';

const CASHFREE_JS = 'https://sdk.cashfree.com/js/v3/cashfree.js';

function page(c: Context, title: string, bodyHtml: string, status: 200 | 404 = 200): Response {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;text-align:center;color:#1a1a1a}` +
      `button{font-size:1.1rem;padding:.8rem 1.6rem;border:0;border-radius:.5rem;background:#1f7a3a;color:#fff}</style></head>` +
      `<body>${bodyHtml}</body></html>`,
    status,
  );
}

const inactive = (c: Context) =>
  page(c, 'Link not active', '<h2>This link is no longer active</h2><p>Please go back to WhatsApp.</p>');

/** JSON for embedding inside a <script> block (no `</script>` breakout). */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * `GET /subscribe/:token` — opens Cashfree's AutoPay checkout for a pending subscription. A fresh checkout session
 * is fetched from Cashfree on each visit (the stored one is a fallback). `/done` is Cashfree's return page.
 */
export function subscribePageRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/subscribe/:token/done', (c) =>
    page(c, 'All set', '<h2>All set ✅</h2><p>You can close this page and return to WhatsApp.</p>'),
  );

  app.get('/subscribe/:token', async (c) => {
    const token = c.req.param('token');
    if (!AUTH_TOKEN_RE.test(token)) return c.notFound();
    const sub = await findSubscriptionByAuthToken(deps.db, token);
    if (!sub) return c.notFound();
    const tenant = tenantById(sub.tenantId);
    if (!tenant || sub.status !== 'pending_authorization') return inactive(c);
    let sessionId = sub.cfSessionId;
    try {
      const state = await deps.payments.getSubscription(tenant, sub.id);
      if (state.status !== 'INITIALIZED') return inactive(c);
      sessionId = state.sessionId ?? sessionId;
    } catch (err) {
      deps.log.warn({ tenantId: tenant.id, subscriptionId: sub.id, err: errInfo(err) }, 'subscribe page: cashfree fetch failed; using stored session');
    }
    if (!sessionId) return inactive(c);
    const mode = deps.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
    return page(
      c,
      'Set up AutoPay',
      `<h2>Set up UPI AutoPay</h2><p>${tenant.name}: approve AutoPay in your UPI app. ₹1 is taken to verify and refunded.</p>` +
        `<button id="go">Continue</button><p id="err" style="color:#b00"></p>` +
        `<script src="${CASHFREE_JS}"></script><script>` +
        `function go(){try{Cashfree({mode:${scriptJson(mode)}}).subscriptionsCheckout({subsSessionId:${scriptJson(sessionId)},redirectTarget:'_self'})` +
        `.then(function(r){if(r&&r.error)document.getElementById('err').textContent='Could not open AutoPay. Please try again.';});}` +
        `catch(e){document.getElementById('err').textContent='Could not open AutoPay. Please try again.';}}` +
        `document.getElementById('go').onclick=go;go();</script>`,
    );
  });

  return app;
}
