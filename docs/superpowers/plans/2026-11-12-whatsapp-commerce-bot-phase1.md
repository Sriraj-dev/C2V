# WhatsApp Commerce Bot (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-tenant WhatsApp bot server that lets NutriFarm customers place one-time orders and weekly subscriptions through WhatsApp Flows, pay via Cashfree, and persists everything for a later dashboard.

**Architecture:** Hono HTTP app on Node 22 with feature modules (`bot`, `orders`, `payments`, `subscriptions`, …) behind two ports — `WhatsAppSender` and `PaymentProvider` — so tests use fakes and tenants/providers are swappable. Postgres (Supabase) via Drizzle; webhooks processed inline with idempotency on provider ids. A daily Cloud Scheduler job handles subscription charges, expiry and retention.

**Tech Stack:** Node 22, TypeScript (strict), pnpm, Hono + `@hono/node-server`, Drizzle ORM + `postgres` (postgres-js), Zod, Vitest, `@electric-sql/pglite` (tests only), pino, tsx.

**Spec:** `docs/superpowers/specs/2026-11-12-whatsapp-commerce-bot-design.md`

## Global Constraints

- Node `>=22`; TypeScript `strict: true`; ESM (`"type": "module"`).
- Money is always integer **paise** (`*_paise` columns, `number` in TS). Format only at the message boundary as `₹1,234` (no decimals when whole, else two).
- Timezone for all business dates: `Asia/Kolkata` (fixed +05:30). Dates stored as `date` (`YYYY-MM-DD`) for delivery dates, `timestamptz` otherwise.
- **Tenant config lives in code** (`src/tenants/<id>/config.ts`, type `TenantConfig`), registered in `src/tenants/registry.ts` keyed by `waPhoneNumberId`. Only vendor-editable values live in the `tenants` table (`support_phone`, `delivery_fee_paise`, `min_order_paise`). Rule: if the vendor can edit it from the dashboard → DB; otherwise → code.
- Every business table has `tenant_id text not null` (FK → `tenants.id`, e.g. `'nutrifarm'`) and every repo query filters by it.
- Customer-facing order identifier is `order_code` = `<prefix>-<6 chars>` from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), unique per tenant, retry on collision. Internal key is `orders.id` (uuid). No counters.
- No Redis, no queue. Webhook handlers finish their work before responding.
- Payment link expiry: `30` minutes (`TenantConfig.paymentLinkExpiryMinutes`).
- `TenantConfig.messageRetentionDays` = `3`; `TenantConfig.subscriptionChargeLeadDays` = `2`. DB defaults: `delivery_fee_paise` `0`, `min_order_paise` `0`.
- Subscription frequency step: `weekly` = 7 days, `biweekly` = 14, `monthly` = 28 (always lands on the pincode weekday). Only `weekly` is offered in the Flow for Phase 1; the column supports all three.
- Order statuses exactly: `payment_pending | confirmed | assigned | out_for_delivery | delivered | cancelled | payment_failed | expired`.
- Subscription statuses exactly: `pending_authorization | active | cancelled | authorization_failed`.
- Graph API base: `https://graph.facebook.com/${GRAPH_API_VERSION}`; `GRAPH_API_VERSION` is an env var — set it to the latest stable version from Meta's changelog at implementation time.
- Cashfree base: sandbox `https://sandbox.cashfree.com/pg`, prod `https://api.cashfree.com/pg`; header `x-api-version: 2025-01-01`. Before coding each Cashfree call, confirm field names against cashfree.com/docs (API reference, latest) — the adapter interface in this plan is fixed, the wire format must match the docs.
- English only. All customer-facing copy lives in `src/tenants/<id>/copy.ts`.
- Send messages to `wa_id` when known, otherwise to the BSUID `user_id`.
- Tests: Vitest; DB tests run on PGlite with the real Drizzle migrations; never call real WhatsApp/Cashfree in tests.
- Commit after every task with Conventional Commit messages.

## Review Focus

1. **Duplicate webhooks** (Meta and Cashfree both retry) → no second order confirmation, no duplicate reply. Tests in Task 5 (inbound dedupe) and Task 11 (paid twice).
2. **WhatsApp `statuses`-only webhooks** (sent/delivered/read arrive constantly, no `messages`) → 200 and nothing else. Test in Task 4.
3. **Flow submitted with every quantity 0 or a malformed pincode** (`" 560 035"`, 5 digits) → friendly reply, no order row. Tests in Task 9.
4. **Forged or amount-mismatched Cashfree webhook** → rejected; an order is marked paid only after a server-side GET shows PAID with the exact amount. Tests in Tasks 10 and 11.
5. **Customer with a username and no phone (`wa_id` absent)** → still identified, stored and replied to via BSUID. Tests in Tasks 4 and 5.

---

## File Structure

```
src/
  index.ts                         # boot: env → db → deps → serve
  app.ts                           # buildApp(deps): Hono routes
  deps.ts                          # AppDeps type + buildProdDeps()
  config/env.ts                    # zod-validated env
  db/schema.ts                     # all Drizzle tables/enums
  db/client.ts                     # createDb(url) for prod; Db type
  db/migrations/                   # drizzle-kit output
  domain/money.ts                  # formatPaise, sumLines
  domain/delivery-date.ts          # nextDeliveryDate, formatDeliveryDate
  domain/pincode.ts                # normalizePincode
  tenants/types.ts                 # TenantConfig, TenantCopy, TenantSettings
  tenants/registry.ts              # tenantByPhoneNumberId, tenantById, allTenants
  tenants/settings-repo.ts         # getTenantSettings (vendor-editable row)
  tenants/nutrifarm/config.ts      # NutriFarm constants
  tenants/nutrifarm/copy.ts        # NutriFarm message texts
  domain/order-code.ts             # generateOrderCode
  channels/whatsapp/signature.ts   # verifyMetaSignature
  channels/whatsapp/webhook-schema.ts  # zod schema for webhook payload
  channels/whatsapp/parse.ts       # parseWebhook → InboundMessage[]
  channels/whatsapp/builders.ts    # payload builders (text, buttons, cta_url, flow, template)
  channels/whatsapp/sender.ts      # WhatsAppSender port + GraphWhatsAppSender + LoggingSender
  channels/whatsapp/flows.ts       # buildOrderFlowJson, buildSubscribeFlowJson, publishFlow
  customers/customer-repo.ts       # upsertCustomer, saveDefaultAddress
  messages/message-store.ts        # recordInbound (dedupe), recordOutbound, purgeOlderThan
  catalog/catalog-repo.ts          # listActiveProducts, findPincode
  orders/order-repo.ts             # insert/find/update orders + items
  orders/order-service.ts          # createOrder, startPayment, confirmPaidOrder, updateStatus, refundOrder, expireStale
  payments/provider.ts             # PaymentProvider port + types
  payments/cashfree/client.ts      # CashfreeProvider implements PaymentProvider
  payments/cashfree/webhook.ts     # verifyCashfreeSignature, parseCashfreeEvent
  payments/payment-repo.ts         # payments table access
  subscriptions/subscription-service.ts  # create, activate, raiseDueCharges, onChargeResult, cancel
  bot/router.ts                    # handleInbound(deps, tenant, msg)
  bot/menu.ts                      # sendMenu, sendHelp
  bot/order-flow-handler.ts        # sendOrderFlow, onOrderFlowSubmit
  bot/subscribe-flow-handler.ts    # sendSubscribeFlow, onSubscribeFlowSubmit
  bot/my-orders.ts                 # sendMyOrders
  ingress/whatsapp-routes.ts       # GET/POST /webhooks/whatsapp
  ingress/cashfree-routes.ts       # POST /webhooks/cashfree
  ingress/jobs-routes.ts           # POST /jobs/daily
  jobs/daily.ts                    # runDailyJob
scripts/
  seed.ts                          # tenant + products + pincodes for NutriFarm
  publish-flows.ts                 # build & publish Flow JSON once, print flow ids to paste into config.ts
  orders.ts                        # CLI: assign | out-for-delivery | delivered | cancel | refund
tests/
  helpers/test-db.ts               # PGlite + migrations + factory helpers
  helpers/fakes.ts                 # FakeWhatsAppSender, FakePaymentProvider, fixed clock
  ...mirrors src/
Dockerfile, .env.example, drizzle.config.ts, vitest.config.ts, tsconfig.json, package.json
```

Shared dependency object used by everything below (defined in Task 1, extended as ports arrive):

```ts
// src/deps.ts
export interface AppDeps {
  db: Db;
  env: Env;
  whatsapp: WhatsAppSender;      // Task 6
  payments: PaymentProvider;     // Task 10
  now: () => Date;
  log: Logger;                   // pino
}
```

---

### Task 1: Project scaffold, env config, health route

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config/env.ts`, `src/app.ts`, `src/deps.ts`, `src/index.ts`
- Test: `tests/app.test.ts`, `tests/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source: Record<string,string|undefined>): Env`; `buildApp(deps: AppDeps): Hono`; `AppDeps` (fields above; `whatsapp`/`payments` typed as `unknown` placeholders until Tasks 6/10 replace them).
- `Env` keys: `NODE_ENV`, `PORT` (default 8080), `DATABASE_URL`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `GRAPH_API_VERSION`, `CASHFREE_ENV` (`sandbox|production`), `JOBS_SECRET`, `LOG_LEVEL` (default `info`). Per-tenant secrets are read by env-var *name* stored on the tenant row (Task 2), so they are not in `Env`.

- [ ] **Step 1: Init repo tooling** — `pnpm init`, add deps (`hono @hono/node-server drizzle-orm postgres zod pino`) and dev deps (`typescript tsx vitest @types/node drizzle-kit @electric-sql/pglite`). Scripts: `dev` (`tsx watch src/index.ts`), `build` (`tsc -p .`), `start` (`node dist/index.js`), `test` (`vitest run`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`tsx scripts/migrate.ts`). `.gitignore`: `node_modules dist .env* !.env.example .DS_Store`.
- [ ] **Step 2: Write failing tests**

```ts
// tests/config/env.test.ts
it('throws listing missing keys', () => {
  expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
});
it('applies defaults', () => {
  const env = loadEnv({ DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox', JOBS_SECRET: 'j' });
  expect(env.PORT).toBe(8080);
  expect(env.LOG_LEVEL).toBe('info');
});
// tests/app.test.ts
it('GET /health → 200 {ok:true}', async () => {
  const res = await buildApp(testDeps()).request('/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```
(`testDeps()` lives in `tests/helpers/fakes.ts`; for now it returns `{ env, now, log }` with stubs.)
- [ ] **Step 3: Run** `pnpm test` → FAIL (modules missing).
- [ ] **Step 4: Implement** `loadEnv` (zod schema, error message lists every missing key), `buildApp` with `GET /health` (must not touch the DB — health checks must not keep anything awake), `index.ts` boots with `serve({ fetch: app.fetch, port })`.
- [ ] **Step 5: Run** `pnpm test` → PASS; `pnpm build` → no errors.
- [ ] **Step 6: Commit** `chore: scaffold hono app with env config and health route`

---

### Task 2: Database schema, migrations, test DB, seed

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `scripts/migrate.ts`, `scripts/seed.ts`, `tests/helpers/test-db.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `Db` type (Drizzle instance, works for both postgres-js and PGlite); `createDb(url: string): Db` (postgres-js with `prepare: false` for the Supabase transaction pooler, `max: 5`); `createTestDb(): Promise<Db>` (PGlite + `migrate` from `src/db/migrations`); factories `seedTenantRow(db, id = 'test', overrides?)`, `seedProduct(db, tenantId, overrides?)`, `seedPincode(db, tenantId, pincode, weekday)`, `seedCustomer(db, tenantId, overrides?)`. (`testTenant()` moves to Task 4, which defines `TenantConfig`.)
- Indexes (besides the unique constraints): `orders(tenant_id, status, delivery_date)`, `orders(subscription_id)`, `order_items(order_id)`, `payments(order_id)`, `subscriptions(tenant_id, status, next_delivery_date)`, `subscription_items(subscription_id)`, `messages(tenant_id, customer_id, created_at)`, `messages(created_at)` (retention delete). Foreign keys on every `*_id` reference.
- Deferred (spec §9): enabling RLS on all tables to close Supabase's public Data API.
- Tables (all except `tenants` have `id uuid pk default gen_random_uuid()`; all have `created_at timestamptz default now()`):
  - `tenants`: `id text pk` (matches `TenantConfig.id`), `support_phone text`, `delivery_fee_paise int default 0`, `min_order_paise int default 0`, `updated_at`. Nothing else — constants live in `TenantConfig`.
  - `customers`: `tenant_id`, `wa_key` (= `user_id ?? wa_id`), `wa_id` null, `bsuid` null, `profile_name` null, `email` null, `default_address jsonb` null, `default_location jsonb` null (`{lat: number, lng: number}`); unique(`tenant_id`,`wa_key`).
  - `products`: `tenant_id`, `sku`, `name`, `price_paise`, `active bool default true`, `sort_order int`; unique(`tenant_id`,`sku`).
  - `pincodes`: `tenant_id`, `pincode char(6)`, `delivery_weekday smallint` (0=Sun…6=Sat), `active bool default true`, `note` null; unique(`tenant_id`,`pincode`).
  - `orders`: `tenant_id`, `order_code text` (unique(`tenant_id`,`order_code`)), `customer_id`, `source` enum(`one_time`,`subscription`), `subscription_id` null, `status` enum (Global Constraints), `delivery_date date`, `address jsonb`, `location jsonb` null, `pincode`, `subtotal_paise`, `delivery_fee_paise`, `total_paise`, `assigned_partner_id` null, `paid_at` null, `delivered_at` null, `updated_at`.
  - `order_items`: `order_id`, `product_id`, `name`, `unit_price_paise`, `quantity`, `line_total_paise`.
  - `payments`: `tenant_id`, `order_id` **null** (null for a subscription charge until it succeeds), `subscription_id` null, `for_delivery_date date` null, `charge_items jsonb` null (`{productId, name, unitPricePaise, quantity}[]` snapshot of what a subscription charge is for), `provider` (`cashfree`), `kind` enum(`link`,`subscription_charge`), `provider_ref` unique (link_id / charge payment_id), `amount_paise`, `status` enum(`created`,`paid`,`failed`,`expired`,`refunded`), `link_url` null, `raw jsonb` null, `updated_at`; unique(`subscription_id`,`for_delivery_date`) — makes a double charge for the same delivery impossible.
  - `subscriptions`: `id` (ours; also sent to Cashfree as the merchant `subscription_id`), `tenant_id`, `customer_id`, `status` enum (Global Constraints), `frequency` enum(`weekly`,`biweekly`,`monthly`) default `weekly`, `address jsonb`, `location jsonb` null, `pincode`, `delivery_weekday`, `per_delivery_total_paise`, `next_delivery_date date` null, `cf_subscription_id` unique null (Cashfree's own id), `auth_link` null, `updated_at`.
  - `subscription_items`: `subscription_id`, `product_id`, `quantity`.
  - `delivery_partners`: `tenant_id`, `name`, `phone`, `active`.
  - `messages`: `tenant_id`, `customer_id`, `direction` enum(`in`,`out`), `wa_message_id` unique null (outbound failures may have none), `type`, `text` null (human-readable summary), `payload jsonb`.
  - `Address` JSON shape: `{ name: string; line1: string; landmark?: string; pincode: string }`.

- [ ] **Step 1: Write failing test** `tests/db/schema.test.ts`: `createTestDb()` then insert a tenant row + customer; inserting a second customer with the same (`tenant_id`,`wa_key`) rejects; inserting a message twice with the same `wa_message_id` rejects; two `payments` with the same (`subscription_id`,`for_delivery_date`) reject; two orders with the same (`tenant_id`,`order_code`) reject.
- [ ] **Step 2: Run** `pnpm test tests/db` → FAIL.
- [ ] **Step 3: Implement** `schema.ts`, `client.ts`, `drizzle.config.ts`; run `pnpm db:generate` to produce the first migration; implement `createTestDb` and factories.
- [ ] **Step 4: Run** `pnpm test tests/db` → PASS.
- [ ] **Step 5: Seed script** `scripts/seed.ts` (idempotent upserts, values are constants in the script — not env vars; the vendor edits them in the DB later) for NutriFarm: `tenants` row `id='nutrifarm'`, `support_phone` `918310901383`; products `EGG_W_6` "White Eggs – 6 pack" `9000`, `EGG_W_12` "White Eggs – 12 pack" `16800`, `EGG_W_30` "White Eggs – 30 pack" `39000` (sort_order 1/2/3); pincodes `560034`, `560102`, `560076` → weekday 3 (Wed), `560068`, `560037` → weekday 6 (Sat); delivery partner Ravi `919398651343`. Run `pnpm db:migrate` and `pnpm db:seed` against the Supabase dev project and verify rows exist.
- [ ] **Step 6: Commit** `feat(db): schema, migrations, test db helper and seed`

---

### Task 3: Domain utilities — money, pincode, delivery date

**Files:**
- Create: `src/domain/money.ts`, `src/domain/pincode.ts`, `src/domain/delivery-date.ts`
- Test: `tests/domain/*.test.ts`

**Interfaces:**
- Create also: `src/domain/order-code.ts`.
- Produces: `formatPaise(p: number): string`; `normalizePincode(raw: string): string | null`; `nextDeliveryDate(now: Date, weekday: number): string` (returns `YYYY-MM-DD` in IST); `formatDeliveryDate(isoDate: string): string` (e.g. `Wed, 18 Nov`); `addDays(isoDate: string, days: number): string`; `frequencyStepDays(f: 'weekly'|'biweekly'|'monthly'): 7|14|28`; `generateOrderCode(prefix: string, random?: (n: number) => Uint8Array): string` (default uses `crypto.getRandomValues`).
- Extra tests: `generateOrderCode('NF')` matches `/^NF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/`; with an injected deterministic `random` it returns a known value; `addDays('2026-11-18', 28) === '2026-12-16'`; `frequencyStepDays('monthly') === 28`.

- [ ] **Step 1: Write failing tests**

```ts
expect(formatPaise(48000)).toBe('₹480');
expect(formatPaise(123456)).toBe('₹1,234.56');
expect(normalizePincode(' 560 035 ')).toBe('560035');
expect(normalizePincode('56003')).toBeNull();
expect(normalizePincode('5600351')).toBeNull();
expect(normalizePincode('abcdef')).toBeNull();
// 2026-11-12 is a Thursday in IST
expect(nextDeliveryDate(new Date('2026-11-12T06:00:00Z'), 3)).toBe('2026-11-18'); // next Wed
expect(nextDeliveryDate(new Date('2026-11-18T06:00:00Z'), 3)).toBe('2026-11-25'); // ordering ON Wed → next week
// 2026-11-17T20:00Z is Wed 01:30 IST → still Wednesday in IST → next week
expect(nextDeliveryDate(new Date('2026-11-17T20:00:00Z'), 3)).toBe('2026-11-25');
expect(formatDeliveryDate('2026-11-18')).toBe('Wed, 18 Nov');
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** IST = UTC+05:30 fixed (no DST): shift the instant by 330 minutes, read the UTC weekday/date, add `((weekday - today + 7) % 7) || 7` days. Pincode: strip whitespace, must match `^[1-9][0-9]{5}$`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(domain): money formatting, pincode normalisation, delivery date`

---

### Task 4: WhatsApp webhook ingress — verification, signature, parsing, tenant resolution

**Files:**
- Create: `src/channels/whatsapp/signature.ts`, `src/channels/whatsapp/webhook-schema.ts`, `src/channels/whatsapp/parse.ts`, `src/tenants/types.ts`, `src/tenants/registry.ts`, `src/tenants/settings-repo.ts`, `src/tenants/nutrifarm/config.ts`, `src/ingress/whatsapp-routes.ts`
- Modify: `src/app.ts` (mount routes), `tests/helpers/test-db.ts` (add `testTenant(overrides?): TenantConfig` — id `'test'`, fake env names, flow ids `'flow-order'`/`'flow-sub'`, prefix `'TS'`)
- Test: `tests/channels/whatsapp/parse.test.ts`, `tests/channels/whatsapp/signature.test.ts`, `tests/ingress/whatsapp-routes.test.ts`, `tests/fixtures/wa/*.json`

**Interfaces:**
- Produces:
  - `verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean` — header `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of raw body, constant-time compare.
  - `InboundMessage` (discriminated on `kind`):
    ```ts
    type InboundBase = { phoneNumberId: string; waMessageId: string; timestamp: number;
      from: { waId: string | null; bsuid: string | null; profileName: string | null }; raw: unknown };
    type InboundMessage = InboundBase & (
      | { kind: 'text'; text: string }
      | { kind: 'button'; replyId: string; title: string }          // button_reply and list_reply
      | { kind: 'flow_submit'; flowToken: string; response: Record<string, unknown> } // nfm_reply
      | { kind: 'location'; lat: number; lng: number }
      | { kind: 'other'; waType: string });
    ```
  - `parseWebhook(body: unknown): InboundMessage[]` — ignores `statuses`, `errors`, and non-`messages` fields; `from.bsuid` from `contacts[].user_id`, `from.waId` from `messages[].from`/`contacts[].wa_id` (either may be absent).
  - `TenantConfig` (in `tenants/types.ts`):
    ```ts
    interface TenantConfig {
      id: string; name: string;
      waPhoneNumberId: string; wabaId: string; waTokenEnv: string;
      cashfree: { appIdEnv: string; secretEnv: string };
      flows: { orderFlowId: string; subscribeFlowId: string };
      orderCodePrefix: string;
      paymentLinkExpiryMinutes: number; subscriptionChargeLeadDays: number; messageRetentionDays: number;
      copy: TenantCopy;   // TenantCopy defined in Task 6; use `unknown` until then
    }
    ```
    Every later signature that says `tenant` means `TenantConfig`.
  - `registry.ts`: `registerTenants(list: TenantConfig[])` (throws on duplicate `id` or `waPhoneNumberId`), `tenantByPhoneNumberId(id): TenantConfig | null`, `tenantById(id): TenantConfig | null`, `allTenants(): TenantConfig[]`. `index.ts` calls `registerTenants([nutrifarm])` at boot.
  - `nutrifarm/config.ts`: real `waPhoneNumberId`/`wabaId` (from the WhatsApp Business MCP, business `organic_nutri_farm`), `waTokenEnv: 'NUTRIFARM_WA_TOKEN'`, `cashfree: { appIdEnv: 'NUTRIFARM_CF_APP_ID', secretEnv: 'NUTRIFARM_CF_SECRET' }`, `orderCodePrefix: 'NF'`, `30` / `2` / `3`; flow ids are empty strings until Task 8 publishes them.
  - `settings-repo.ts`: `type TenantSettings = { supportPhone: string | null; deliveryFeePaise: number; minOrderPaise: number }`; `getTenantSettings(db, tenantId): Promise<TenantSettings>` (throws if the row is missing).
  - `buildApp(deps, opts?: { onInbound?: (tenant: TenantConfig, msg: InboundMessage) => Promise<void> })`. Tenant is resolved with `tenantByPhoneNumberId` — no DB read. Route `POST /webhooks/whatsapp` calls `onInbound(tenant, msg)` for each message (default wired to `handleInbound` in Task 7; tests inject a spy). Unknown tenant → log warn, still 200.
  - Route `GET /webhooks/whatsapp` echoes `hub.challenge` when `hub.mode=subscribe` and token matches, else 403.

- [ ] **Step 1: Fixtures** — save realistic payloads under `tests/fixtures/wa/`: `text.json`, `button-reply.json`, `list-reply.json`, `flow-nfm-reply.json`, `statuses-only.json`, `text-username-no-phone.json` (contacts has `user_id` + `profile.username`, no `wa_id`/`from`), `image.json`, `location.json`.
- [ ] **Step 2: Write failing tests**
  - parse: each fixture maps to the expected `kind`; `statuses-only.json` → `[]`; username fixture → `from.waId === null && from.bsuid === 'IN.…'`; `flow-nfm-reply` → `response` is the parsed `response_json` object and `flowToken` its `flow_token`.
  - signature: valid header → true; tampered body → false; missing header → false.
  - routes: GET with right token → 200 body = challenge; wrong token → 403. POST with bad signature → 401 and `onInbound` not called. POST statuses-only with good signature → 200, `onInbound` not called. POST text → `onInbound` called once with the tenant registered for that `phone_number_id` (register `testTenant()` in the test); unknown `phone_number_id` → 200, `onInbound` not called. Registry: duplicate `waPhoneNumberId` throws.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** Read raw body with `c.req.text()` before JSON-parsing (signature needs exact bytes). Zod schema is permissive (`passthrough`) — validate only fields we read.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(whatsapp): webhook verification, signature check and payload parsing`

---

### Task 5: Customers and message log (inbound dedupe)

**Files:**
- Create: `src/customers/customer-repo.ts`, `src/messages/message-store.ts`
- Test: `tests/customers/customer-repo.test.ts`, `tests/messages/message-store.test.ts`

**Interfaces:**
- Produces:
  - `type Customer` (row); `upsertCustomer(db, tenantId, from: InboundMessage['from']): Promise<Customer>` — `wa_key = bsuid ?? waId`; on conflict updates `wa_id`/`bsuid`/`profile_name` when the new value is non-null.
  - `recipientOf(c: Customer): string` → `c.wa_id ?? c.bsuid!`.
  - `saveDefaultAddress(db, customerId, address: Address): Promise<void>`; `saveEmail(db, customerId, email: string)`.
  - `recordInbound(db, tenantId, customerId, msg: InboundMessage): Promise<boolean>` — inserts with `ON CONFLICT (wa_message_id) DO NOTHING`; returns `false` when it was a duplicate.
  - `recordOutbound(db, args: { tenantId; customerId; waMessageId: string | null; type: string; text: string | null; payload: unknown }): Promise<void>`.
  - `purgeMessagesOlderThan(db, tenantId, days: number, now: Date): Promise<number>`.

- [ ] **Step 1: Write failing tests**
  - `upsertCustomer` twice with same bsuid → one row; second call with a newly-known `waId` fills `wa_id`.
  - Customer with only `waId` (no bsuid) → `wa_key === waId`; `recipientOf` returns it. Customer with only bsuid → `recipientOf` returns bsuid.
  - `recordInbound` same message twice → `true` then `false`, one row.
  - `purgeMessagesOlderThan(…, 3, now)` deletes a 4-day-old row, keeps a 2-day-old row, and only for that tenant.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: customer upsert by bsuid/wa_id and message log with dedupe`

---

### Task 6: WhatsApp sender, payload builders, tenant copy

**Files:**
- Create: `src/channels/whatsapp/builders.ts`, `src/channels/whatsapp/sender.ts`, `src/tenants/nutrifarm/copy.ts`, `tests/helpers/fakes.ts` (extend)
- Modify: `src/deps.ts` (type `whatsapp: WhatsAppSender`)
- Test: `tests/channels/whatsapp/builders.test.ts`, `tests/channels/whatsapp/sender.test.ts`

**Interfaces:**
- Produces:
  - Builders return the Graph `messages` body without `to`/`messaging_product`:
    `textMsg(body)`, `replyButtonsMsg(body, buttons: {id: string; title: string}[] /*1–3, title ≤20 chars*/)`, `ctaUrlMsg({ body, buttonText /*≤20*/, url, footer? })`, `flowMsg({ body, flowId, flowToken, cta /*≤20*/, screen, data })` (interactive `flow`, `flow_message_version: "3"`, `flow_action: "navigate"`, `flow_action_payload: { screen, data }`), `templateMsg(name, lang, bodyParams: string[])`.
    Additional builders (toolbox for later tasks): `locationRequestMsg(body)`; `listMsg({ body, buttonText /*≤20*/, sections: {title?; rows: {id; title /*≤24*/; description? /*≤72*/}[]}[] /*≤10 rows total*/, header?, footer? })`; `imageMsg({ link, caption? })`, `documentMsg({ link, filename?, caption? })`, `audioMsg({ link })`; optional `header` (`{ type: 'text', text }` or `{ type: 'image', link }`) on `replyButtonsMsg`/`listMsg`/`ctaUrlMsg`; `locationMsg({ lat, lng, name?, address? })`; `contactsMsg(contacts)`; `reactionMsg(messageId, emoji)`; `addressMsg({ body, values? })` (interactive `address_message`, country `IN`). Every send accepts an optional `replyTo` (waMessageId → `context.message_id`). Check each shape against Meta's Cloud API message reference.
  - `interface WhatsAppSender { send(tenant: TenantConfig, to: string, message: OutboundMessage): Promise<{ waMessageId: string }> }`.
  - `GraphWhatsAppSender(env, fetchImpl = fetch)` — POST `${base}/${tenant.waPhoneNumberId}/messages` with `Authorization: Bearer ${process.env[tenant.waTokenEnv]}`; throws `WhatsAppSendError` (status + Meta error code) on non-2xx. Also `markRead(tenant, waMessageId, opts?: { typing?: boolean }): Promise<void>` — POST `{ messaging_product, status: 'read', message_id, typing_indicator?: { type: 'text' } }` (blue ticks, optionally "typing…"); part of the `WhatsAppSender` interface.
  - `sendAndLog(deps, tenant, customer, message, summaryText): Promise<void>` — sends via `deps.whatsapp` to `recipientOf(customer)` and calls `recordOutbound`; on send failure still records the outbound row with `waMessageId: null` and rethrows.
  - `TenantCopy` interface (in `tenants/types.ts`) with functions: `welcome(name: string|null)`, `help()`, `orderFlowIntro()`, `subscribeFlowIntro()`, `noItems()`, `invalidPincode(raw)`, `notServiceable(pincode)`, `orderSummary(o: {orderCode; lines: {name; qty; lineTotal: string}[]; total: string; deliveryDate: string})`, `orderConfirmed({orderCode; deliveryDate})`, `subscriptionSummary({lines; perDelivery: string; weekdayName: string; firstDelivery: string})`, `subscriptionActive({firstDelivery})`, `myOrders(rows: {orderCode; status; deliveryDate; total}[], subs: {perDelivery; weekdayName; nextDelivery}[])`, `invalidEmail()`, `genericError()`, `askLocation()`, `locationSaved()`. Accessed as `tenant.copy` (no separate registry).
  - `FakeWhatsAppSender` records `{to, message}[]` and returns incrementing `wamid.fake.N`.

- [ ] **Step 1: Write failing tests** — builders produce exactly the Graph shapes (snapshot each builder once); `replyButtonsMsg` throws for >3 buttons or title >20 chars; `GraphWhatsAppSender` with a stub `fetchImpl` hits the right URL/headers and maps a 400 to `WhatsAppSendError`; `sendAndLog` writes one `messages` row with direction `out`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (NutriFarm copy: friendly, short, emoji-light; `orderSummary` ends with "Tap *Pay* below. The link is valid for 30 minutes.").
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): message builders, graph sender, tenant copy`

---

### Task 7: Bot router — menu, help, fallback

> Note: after `recordInbound` returns `true` (not a duplicate), call `deps.whatsapp.markRead(tenant, msg.waMessageId, { typing: true })` before handling — best effort: log and continue on failure.

**Files:**
- Create: `src/bot/router.ts`, `src/bot/menu.ts`
- Modify: `src/app.ts` (wire `onInbound` → `handleInbound`)
- Test: `tests/bot/router.test.ts`

**Interfaces:**
- Consumes: `upsertCustomer`, `recordInbound`, `sendAndLog`, `tenant.copy`, `getTenantSettings`.
- Produces:
  - Button ids (constants in `router.ts`): `menu:order`, `menu:subscribe`, `menu:my_orders`, `menu:help`.
  - Flow token format: `${'order'|'subscribe'}:${customerId}:${randomId}`.
  - `handleInbound(deps, tenant, msg): Promise<void>`: upsert customer → `recordInbound` (return early if duplicate) → dispatch:
    - `button menu:order` → `sendOrderFlow` (Task 8); `menu:subscribe` → `sendSubscribeFlow` (Task 13); `menu:my_orders` → `sendMyOrders` (Task 12); `menu:help` → `sendHelp`.
    - `flow_submit` with token prefix `order:` → `onOrderFlowSubmit`; `subscribe:` → `onSubscribeFlowSubmit`.
    - `location` → `onLocationShared` (Task 11).
    - anything else → `sendMenu`.
    - Any thrown error → log, `sendAndLog(copy.genericError())` (best effort), never rethrow (webhook must 200).
  - `sendMenu(deps, tenant, customer)`: if `settings.welcomeImageUrl` is set, first `imageMsg({ link, caption: copy.welcome(name) })`; then a `listMsg` (button text "Menu") with 4 rows — `menu:order` Order Eggs, `menu:subscribe` Subscribe, `menu:my_orders` My Orders, `menu:help` Help (each with a short description from copy). WhatsApp allows max 3 reply buttons and list headers are text-only, hence image + list. Without an image the list body carries the welcome text.
  - New vendor-editable setting: nullable `tenants.welcome_image_url` (new migration via `pnpm db:generate`), exposed as `TenantSettings.welcomeImageUrl: string | null`; seed sets it for new rows; dev DB row updated to a temporary public image.
  - `sendHelp`: CTA-URL button `tel:+<settings.supportPhone>` (read via `getTenantSettings`, so the vendor can change it from the dashboard); if supportPhone is null, reply with plain text help and log a warning.
  - Until Tasks 8/12/13 exist, those dispatch targets are stubs that call `sendMenu`; each later task replaces its stub.

- [ ] **Step 1: Write failing tests** (PGlite + FakeWhatsAppSender): text "hi" → image (when welcomeImageUrl set) then list menu with the 4 ids above (and list-only when unset), inbound + outbound rows in `messages`; same inbound delivered twice → only one reply; `menu:help` → CTA with `tel:` URL; image message → menu; handler throwing → generic error sent and `handleInbound` resolves.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(bot): inbound router with menu, help and fallback`

---

### Task 8: Order Flow JSON + publishing script + sending the Flow

**Files:**
- Create: `src/channels/whatsapp/flows.ts`, `scripts/publish-flows.ts`, `src/bot/order-flow-handler.ts` (send part), `src/catalog/catalog-repo.ts`
- Test: `tests/channels/whatsapp/flows.test.ts`, `tests/bot/order-flow-send.test.ts`

**Interfaces:**
- Produces:
  - `listActiveProducts(db, tenantId): Promise<Product[]>` (ordered by `sort_order`); `findActivePincode(db, tenantId, pincode): Promise<Pincode | null>`.
  - `MAX_PRODUCT_SLOTS = 8` (constant in `flows.ts`). The Flow JSON is **product-independent**, so it is published once and its id is a code constant; products stay fully dynamic from the DB.
  - `buildOrderFlowJson(): object` — Flow JSON (latest version listed in Meta's Flow JSON changelog), no `data_api_version` (no endpoint). Screens:
    - `PRODUCTS`: for slot `i` in `1..8` a `Dropdown` named `qty_<i>` with options `"0"`…`"10"`, `init-value "0"`, `label: "${data.label_<i>}"`, `visible: "${data.show_<i>}"`; footer "Next" → `navigate` to `ADDRESS` passing all `qty_*`.
    - `ADDRESS` (terminal): `TextInput name` (required), `TextArea line1` (required), `TextInput landmark` (optional), `TextInput pincode` (required, `input-type: number`), each with `init-value` bound to `${data.prefill_*}`; footer "Continue" → `complete` with payload of all `qty_*` + address fields.
    - Screen `data` declarations include `__example__` values for every bound key.
  - `orderFlowData(products: Product[], prefill: Address | null): { data: Record<string, string | boolean>; slotMap: Record<string, string /*productId*/> }` — product `k` (by `sort_order`) goes to slot `k+1`: `label_<i> = "<name> — ₹<price>"`, `show_<i> = true`; unused slots `show_<i> = false`, `label_<i> = ""`; plus `prefill_name/line1/landmark/pincode` (empty strings when no prefill). Throws if more than 8 active products.
  - The `slotMap` is encoded into the flow token so the submit handler knows which product each slot meant even if products changed meanwhile: token = `order:<customerId>:<base64url(JSON.stringify(slotMap))>` (8 uuids ≈ 400 chars; confirm Meta's flow_token length limit, else store slotMap in the inbound/outbound `messages.payload` and put a short id in the token).
  - `publishFlow(env, tenant, name: string, flowJson: object): Promise<string /*flow id*/>` — `POST /{tenant.wabaId}/flows` with `name`, `categories: ["SHOPPING"]`, `flow_json`, `publish: true` (confirm field names in the Flows API reference).
  - `scripts/publish-flows.ts <tenantId>` builds the flows (subscribe flow arrives in Task 13), publishes, **prints** the ids; the developer pastes them into `tenants/<id>/config.ts`. Only re-run if the Flow *layout* changes (never for product/price changes).
  - `sendOrderFlow(deps, tenant, customer)`: `flowMsg({ body: tenant.copy.orderFlowIntro(), flowId: tenant.flows.orderFlowId, flowToken, cta: 'Order now', screen: 'PRODUCTS', data })`.

- [ ] **Step 1: Write failing tests** — `buildOrderFlowJson()` contains dropdowns `qty_1`…`qty_8` each with `visible: "${data.show_<i>}"`; ADDRESS footer `complete` payload has keys `qty_1..qty_8, name, line1, landmark, pincode`; every `${data.x}` reference has a matching `__example__`. `orderFlowData` with 3 products → `show_1..3 = true`, `show_4..8 = false`, label for price 9000 = `"White Eggs – 6 pack — ₹90"`, `slotMap['1']` = first product id; 9 products → throws. `sendOrderFlow` sends a flow message with `flowId === tenant.flows.orderFlowId`, token starting with `order:<customerId>:`, prefill from `customer.default_address`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Validate for real:** run `pnpm tsx scripts/publish-flows.ts nutrifarm` against the real WABA (needs `NUTRIFARM_WA_TOKEN`); paste the printed id into `nutrifarm/config.ts`; confirm the Flow renders with only the 3 seeded products visible when sent to your own phone.
- [ ] **Step 6: Commit** `feat(flows): order flow json, publisher script and flow send`

---

### Task 9: Order creation from Flow submit (validation + pending order)

**Files:**
- Create: `src/orders/order-repo.ts`, `src/orders/order-service.ts` (create part)
- Modify: `src/bot/order-flow-handler.ts` (submit part, payment step stubbed until Task 11)
- Test: `tests/orders/order-service.create.test.ts`, `tests/bot/order-flow-submit.test.ts`

**Interfaces:**
- Produces:
  - `parseOrderSubmission(response: Record<string, unknown>, slotMap: Record<string,string>, products: Product[]): { lines: {product: Product; quantity: number}[]; address: Address } | { error: 'no_items' | 'invalid_pincode' ; raw?: string }` — maps `qty_<i>` → product via `slotMap`; ignores slots whose product is no longer active, unknown keys and non-integer/negative values (treated as 0); pincode via `normalizePincode`.
  - `createOrder(deps, tenant, customer, input: { lines; address; location: {lat;lng} | null; status: 'payment_pending' | 'confirmed'; source: 'one_time' | 'subscription'; subscriptionId?: string; deliveryDate: string; unitPrices?: Record<string, number> /* productId → paise; overrides DB price (subscription charges) */ }): Promise<OrderWithItems>` — `order_code = generateOrderCode(tenant.orderCodePrefix)`, retry up to 3 times on unique violation; totals: `subtotal = Σ unit_price × qty` using **DB prices** unless `unitPrices` given, `delivery_fee = settings.deliveryFeePaise`, `total = subtotal + fee`. Order + items in one transaction.
  - `OrderWithItems = Order & { items: OrderItem[] }`; repo: `findOrderById`, `findOrderByCode(db, tenantId, code)`, `listRecentOrders(db, tenantId, customerId, limit)`.
  - `onOrderFlowSubmit(deps, tenant, customer, msg)`: parse → on `no_items` send `copy.noItems()`; on invalid pincode send `copy.invalidPincode(raw)`; pincode not in `pincodes` (active) → `copy.notServiceable(pincode)`; else save default address, compute `nextDeliveryDate(deps.now(), pincode.delivery_weekday)`, `createOrder({ status: 'payment_pending', source: 'one_time', location: customer.default_location, … })`, then `startPayment` (Task 11; stub sends the summary text without a button for now).

- [ ] **Step 1: Write failing tests** — all-zero quantities → `noItems` message, zero orders in DB; pincode `" 560 035"` accepted; `"56003"` → invalid message; serviceable but unknown pincode `110001` → notServiceable; valid submit (2×6-pack @ ₹90, 1×30-pack @ ₹420) → one order with `order_code` matching `/^TS-[A-Z2-9]{6}$/`, `total_paise = 60000`, delivery date = next Wednesday from fixed clock, two `order_items`, address saved as customer default; a forced order-code collision (injected `random`) retries and succeeds; a slot whose product was deactivated after the Flow was sent is ignored; a tampered price in the submission is ignored (DB price used).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(orders): validate flow submission and create pending order`

---

### Task 10: PaymentProvider port + Cashfree adapter (links, webhooks, refunds)

**Files:**
- Create: `src/payments/provider.ts`, `src/payments/cashfree/client.ts`, `src/payments/cashfree/webhook.ts`, `src/payments/payment-repo.ts`
- Modify: `src/deps.ts` (`payments: PaymentProvider`), `tests/helpers/fakes.ts` (`FakePaymentProvider`)
- Test: `tests/payments/cashfree/client.test.ts`, `tests/payments/cashfree/webhook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PaymentProvider {
    createPaymentLink(t: TenantConfig, i: { linkId: string; amountPaise: number; purpose: string;
      customerPhone: string | null; customerName: string | null; expiresAt: Date; notifyUrl: string }): Promise<{ linkId: string; url: string }>;
    getPaymentLink(t: TenantConfig, linkId: string): Promise<{ status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'PARTIALLY_PAID'; amountPaidPaise: number }>;
    refundPaymentLink(t: TenantConfig, linkId: string, amountPaise: number, refundId: string): Promise<void>;
    // subscription methods are added in Task 13
  }
  type CashfreeEvent =
    | { type: 'link_paid' | 'link_status'; linkId: string }
    | { type: 'subscription_status'; subscriptionId: string; status: string }
    | { type: 'subscription_charge'; subscriptionId: string; paymentId: string; success: boolean }
    | { type: 'ignored'; raw: string };
  ```
  - `verifyCashfreeSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, secret: string): boolean` — `base64(HMAC_SHA256(timestamp + rawBody, secret))`, constant-time compare.
  - `parseCashfreeEvent(body: unknown): CashfreeEvent`.
  - `CashfreeProvider(env, fetchImpl = fetch)` reads `process.env[tenant.cashfree.appIdEnv]` / `[tenant.cashfree.secretEnv]`; sends `x-client-id`, `x-client-secret`, `x-api-version: 2025-01-01`. Amounts converted paise ↔ rupees only inside the adapter. `customerPhone` null → omit (customers with BSUID only).
  - Payment repo: `insertPayment`, `findPaymentByProviderRef`, `markPayment(db, id, status, raw)`.
  - `FakePaymentProvider` lets tests set link status/amount and records calls.

- [ ] **Step 1: Write failing tests** — client: `createPaymentLink` posts to `/links` with amount `480.00` for 48000 paise, expiry ISO string, `link_notify` off, notify URL in `link_meta`; maps response `link_url`; `getPaymentLink` maps status + amount to paise. webhook: valid signature true; wrong secret false; missing headers false; payment-link fixture → `{type:'link_paid', linkId}`; unknown event → `ignored`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (check each field against Cashfree docs before writing). **Step 4: Run** → PASS.
- [ ] **Step 5: Sandbox check:** small script call `createPaymentLink` with sandbox creds, open the URL, pay with sandbox UPI, confirm `getPaymentLink` → PAID.
- [ ] **Step 6: Commit** `feat(payments): cashfree payment links, webhook verification and refunds`

---

### Task 11: Checkout end to end — Pay button, Cashfree webhook, confirmation

**Files:**
- Create: `src/ingress/cashfree-routes.ts`, `src/bot/location.ts`
- Modify: `src/channels/whatsapp/builders.ts` (`locationRequestMsg(body)`), `src/bot/router.ts` (route `location`), `src/orders/order-service.ts` (`startPayment`, `confirmPaidOrder`), `src/bot/order-flow-handler.ts` (replace stub), `src/app.ts`
- Test: `tests/orders/checkout.test.ts`, `tests/ingress/cashfree-routes.test.ts`

**Interfaces:**
- Produces:
  - `startPayment(deps, tenant, customer, order: OrderWithItems): Promise<void>` — `linkId = order.id` (uuid, unique), `expiresAt = now + tenant.paymentLinkExpiryMinutes`, `notifyUrl = ${PUBLIC_BASE_URL}/webhooks/cashfree` (add `PUBLIC_BASE_URL` to `Env`); insert `payments` row (`kind: link`, `created`); send `ctaUrlMsg({ body: copy.orderSummary(...), buttonText: 'Pay ₹<total>', url })`.
  - `confirmPaidOrder(deps, tenant, linkId): Promise<'confirmed' | 'already' | 'not_paid' | 'amount_mismatch'>` — loads payment by `provider_ref`; if order not `payment_pending` → `already`; calls `getPaymentLink`; requires `status === 'PAID'` and `amountPaidPaise === order.total_paise`; then in one transaction payment → `paid`, order → `confirmed`, `paid_at = now`; then sends `copy.orderConfirmed`, and if `customer.default_location` is null also sends a WhatsApp `location_request_message` with `copy.askLocation()` ("Help our delivery partner find you 📍 — optional"). Mismatch → log error, payment stays, returns `amount_mismatch`.
  - `onLocationShared(deps, tenant, customer, msg: {lat; lng})` (in `src/bot/location.ts`): save `customers.default_location`; set `orders.location` on that customer's orders in `confirmed | assigned | out_for_delivery` and `subscriptions.location` on `active | pending_authorization` subscriptions; reply `copy.locationSaved()`. No serviceability check (pincode decides that).
  - Route `POST /webhooks/cashfree`: verify signature with the tenant's secret (tenant resolved from the payment row of `linkId`/subscription id; unknown ref → 200 + warn); bad signature → 401; dispatch `link_*` → `confirmPaidOrder`; subscription events → Task 14 handlers (stub → 200). Always 200 after handling, including handler errors (logged), so Cashfree does not hammer retries for bugs; the daily job reconciles.

- [ ] **Step 1: Write failing tests** — flow submit → outbound CTA with `Pay ₹600` and the fake link URL, `payments` row `created`; webhook with valid signature + fake link PAID → order `confirmed`, one confirmation message containing the order's `order_code` and `Wed, 18 Nov`, followed by one location request (customer has no location); a customer who already has a location gets no location request; sharing a location updates the customer and their confirmed order and replies once; same webhook again → `already`, still exactly one confirmation; fake link `ACTIVE` → `not_paid`, order stays pending; amount 59900 → `amount_mismatch`, order stays pending; bad signature → 401, nothing changes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(checkout): payment link button, cashfree webhook and order confirmation`

---

### Task 12: My Orders

**Files:**
- Create: `src/bot/my-orders.ts`
- Modify: `src/bot/router.ts` (replace stub)
- Test: `tests/bot/my-orders.test.ts`

**Interfaces:**
- Consumes: `listRecentOrders` (Task 9), subscriptions table (Task 2).
- Produces: `sendMyOrders(deps, tenant, customer)` — last 5 orders with status **not** in (`payment_pending`, `expired`, `payment_failed`) plus `active` subscriptions, via `copy.myOrders`; empty → copy says "No orders yet" and shows menu buttons.

- [ ] **Step 1: Failing tests** — customer with 6 confirmed orders + 1 pending → text lists 5 newest confirmed, pending omitted; no orders → "No orders yet" with menu buttons; status rendered human-readable (`out_for_delivery` → "Out for delivery").
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(bot): my orders`

---

### Task 13: Subscriptions — Subscribe Flow, Cashfree mandate creation, activation

> **ON HOLD (2026-11-14, user):** subscriptions deferred — spec §9 #15.

**Files:**
- Create: `src/subscriptions/subscription-service.ts`, `src/bot/subscribe-flow-handler.ts`
- Modify: `src/channels/whatsapp/flows.ts` (`buildSubscribeFlowJson`), `scripts/publish-flows.ts`, `src/payments/provider.ts` + `src/payments/cashfree/client.ts` (subscription methods), `src/ingress/cashfree-routes.ts`, `src/bot/router.ts`
- Test: `tests/subscriptions/create.test.ts`, `tests/channels/whatsapp/subscribe-flow.test.ts`

**Interfaces:**
- Produces:
  - `PaymentProvider` additions:
    ```ts
    // subscriptionId = our subscriptions.id, sent to Cashfree as the merchant subscription_id; all later calls use it.
    createSubscription(t: TenantConfig, i: { subscriptionId: string; maxAmountPaise: number; customer: { name: string; email: string; phone: string | null };
      returnUrl: string; notifyUrl: string }): Promise<{ cfSubscriptionId: string; authLink: string }>;
    getSubscription(t: TenantConfig, subscriptionId: string): Promise<{ status: 'ACTIVE' | 'INITIALIZED' | 'BANK_APPROVAL_PENDING' | 'CANCELLED' | 'FAILED' | string }>;
    raiseCharge(t: TenantConfig, i: { subscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string }): Promise<void>;
    cancelSubscription(t: TenantConfig, subscriptionId: string): Promise<void>;
    ```
    Cashfree plan type `ON_DEMAND`, payment method UPI. `maxAmountPaise = 2 × per_delivery_total` (headroom for price changes without a new mandate).
  - `buildSubscribeFlowJson()`: `PRODUCTS` screen identical to the order flow (same 8 fixed slots) (labels say "per week"), then `DETAILS` terminal screen = ADDRESS fields + `TextInput email` (`input-type: email`, required). Complete payload adds `email`.
  - `sendSubscribeFlow(deps, tenant, customer)` — token `subscribe:<customerId>:<id>`.
  - `onSubscribeFlowSubmit(deps, tenant, customer, msg)`: reuse `parseOrderSubmission` + pincode checks; email must match `^[^@\s]+@[^@\s]+\.[^@\s]+$` else `copy.invalidEmail()`; save email + default address; insert `subscriptions` (`pending_authorization`, `frequency: 'weekly'`, `delivery_weekday` from pincode, `per_delivery_total_paise`, `location` = customer default) + `subscription_items`; `createSubscription({ subscriptionId: sub.id, … })`; store `cf_subscription_id`, `auth_link`; send `ctaUrlMsg({ body: copy.subscriptionSummary(...), buttonText: 'Set up AutoPay', url: authLink })`.
  - `onSubscriptionStatus(deps, tenant, subscriptionId)`: `getSubscription` (never trust the webhook alone); `ACTIVE` and local `pending_authorization` → set `active`, `next_delivery_date = nextDeliveryDate(now, weekday)`, send `copy.subscriptionActive`; `CANCELLED`/`FAILED` while pending → `authorization_failed`; idempotent.

- [ ] **Step 1: Failing tests** — subscribe flow JSON has `email` field and complete payload includes it; invalid email → invalidEmail message, no subscription row; valid submit → subscription `pending_authorization`, items saved, CTA "Set up AutoPay" with fake auth link, fake provider received `maxAmountPaise = 2 × total`; status webhook (fake ACTIVE) → `active`, `next_delivery_date` = next weekday, one activation message; repeated webhook → no second message.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (verify Cashfree subscription field names in docs; republish flows via script). **Step 4: Run** → PASS.
- [ ] **Step 5: Sandbox check** — create a sandbox subscription, open auth link, approve, confirm webhook → active.
- [ ] **Step 6: Commit** `feat(subscriptions): subscribe flow, upi autopay mandate creation and activation`

---

### Task 14: Daily job — subscription charges, charge results, expiry, retention, DB size

> **RESCOPED (2026-11-14, user):** only the `PAYMENT_LINK_EVENT` EXPIRED/CANCELLED webhook handling (order + payment → `expired`, customer told the link expired) and message retention. Subscription charges are on hold (spec §9 #15); the missed-webhook reconcile job is deferred (spec §9 #14).

> Note: `payments` is unique on (`subscription_id`, `for_delivery_date`) — a failed charge is never retried with a new row; that delivery is skipped (or the existing row is updated).

**Files:**
- Create: `src/jobs/daily.ts`, `src/ingress/jobs-routes.ts`
- Modify: `src/subscriptions/subscription-service.ts` (`raiseDueCharges`, `onChargeResult`), `src/orders/order-service.ts` (`expireStalePendingOrders`), `src/ingress/cashfree-routes.ts`, `src/app.ts`
- Test: `tests/jobs/daily.test.ts`, `tests/subscriptions/charges.test.ts`

**Interfaces:**
- Produces:
  - `raiseDueCharges(deps, tenant): Promise<number>` — for `active` subscriptions with `next_delivery_date <= today + tenant.subscriptionChargeLeadDays`: build `charge_items` from `subscription_items` at **current** prices; amount = Σ + `settings.deliveryFeePaise`; insert `payments` (`kind: subscription_charge`, `order_id: null`, `subscription_id`, `for_delivery_date = next_delivery_date`, `charge_items`, `provider_ref = payment.id`, `status: created`) — on unique violation of (`subscription_id`,`for_delivery_date`) skip (already raised); `raiseCharge({ subscriptionId, paymentId: payment.id, amountPaise, scheduleDate: addDays(next_delivery_date, -1) })`; then `next_delivery_date = addDays(next_delivery_date, frequencyStepDays(sub.frequency))`. The date advances **when the charge is raised**, not on success, so a slow/failed debit can never cause a second charge for the same delivery and a failed week is simply skipped.
  - `onChargeResult(deps, tenant, paymentId, success)`: load payment by `provider_ref`; if already `paid`/`failed` → no-op. Success → `createOrder({ status: 'confirmed', source: 'subscription', subscriptionId, deliveryDate: for_delivery_date, lines/unitPrices from charge_items, address/location from the subscription })`, set `payments.order_id`, payment `paid`, order `paid_at` (no message to customer — weekly spam is unwanted). Failure → payment `failed`, no order, send template `subscription_charge_failed` with params `[formatDeliveryDate(for_delivery_date)]`.
  - `expireStalePendingOrders(deps, tenant): Promise<number>` — one-time `payment_pending` orders older than `tenant.paymentLinkExpiryMinutes` whose link `getPaymentLink` is not PAID → order `expired`, payment `expired`; if PAID (missed webhook) → `confirmPaidOrder`.
  - `runDailyJob(deps): Promise<{ tenants: number; charges: number; expired: number; purged: number; dbBytes: number }>` — for each of `allTenants()`: `raiseDueCharges`, `expireStalePendingOrders`, `purgeMessagesOlderThan(tenant.messageRetentionDays)`; then `select pg_database_size(current_database())`, log **warn** when > 400 MB.
  - Route `POST /jobs/daily` requires header `x-jobs-secret === env.JOBS_SECRET` (else 401); returns the summary JSON.

- [ ] **Step 1: Failing tests** (fixed clock Thu 2026-11-12 IST, lead 2 days): active weekly subscription with next delivery Wed 18 Nov → not charged on 12 Nov; clock 16 Nov → one `payments` row (`created`, `for_delivery_date 2026-11-18`, `order_id null`), **no order yet**, `raiseCharge` scheduleDate `2026-11-17`, next date becomes `2026-11-25`; running twice on 16 Nov → still one payment; a `monthly` subscription advances to `2026-12-16`. Charge success → exactly one order (`confirmed`, `source: subscription`, delivery `2026-11-18`, items = `charge_items` even if the product price changed after raising), payment `paid` with `order_id` set, no outbound message; same success webhook again → still one order; failure → payment `failed`, no order, template `subscription_charge_failed` sent, `next_delivery_date` stays `2026-11-25`. Pending one-time order 31 min old with link ACTIVE → `expired`; with link PAID → `confirmed`. Messages older than retention purged. `/jobs/daily` without secret → 401.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(jobs): daily job for subscription charges, expiry, retention and db size`

---

### Task 15: Order operations CLI — assign, out for delivery, delivered, cancel, refund

**Files:**
- Modify: `src/orders/order-service.ts` (`updateStatus`, `refundOrder`)
- Create: `scripts/orders.ts`
- Test: `tests/orders/status.test.ts`

**Interfaces:**
- Produces:
  - Allowed transitions: `confirmed → assigned | cancelled`, `assigned → out_for_delivery | assigned (reassign) | cancelled`, `out_for_delivery → delivered | cancelled`. Anything else throws `InvalidTransitionError`.
  - `updateStatus(deps, tenant, orderId, to: 'assigned' | 'out_for_delivery' | 'delivered' | 'cancelled', opts?: { partnerId?: string }): Promise<Order>` — `assigned` requires an active `partnerId`; `delivered` sets `delivered_at` and sends template `order_delivered` with params `[orderCode]` to the customer; other transitions send nothing.
  - `refundOrder(deps, tenant, orderId): Promise<void>` — only for one-time orders with a `paid` link payment; calls `refundPaymentLink` (refund id = `rf-<orderId without dashes>` (Cashfree max 40 chars)), payment → `refunded`, order → `cancelled` if not delivered. Subscription-charge refunds are out of scope (throw `NotSupportedError`).
  - `cancelSubscription(deps, tenant, subscriptionId): Promise<void>` (in `subscription-service.ts`) — provider `cancelSubscription`, status → `cancelled`, `next_delivery_date = null`; already-raised orders are untouched.
  - CLI: `pnpm tsx scripts/orders.ts <tenantId> <orderCode> assign <partnerPhone> | out-for-delivery | delivered | cancel | refund`, and `pnpm tsx scripts/orders.ts <tenantId> sub <subscriptionId> cancel`. Phase 2 dashboard calls these same service functions.

- [ ] **Step 1: Failing tests** — confirmed → assigned (with partner) → out_for_delivery → delivered sends exactly one `order_delivered` template; `payment_pending → delivered` throws; assign without partner throws; refund of paid one-time order calls provider once and marks payment `refunded`; refund of unpaid order throws.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(orders): status transitions, delivered template, refund and ops cli`

---

### Task 16: Deployment — Docker, Cloud Run, Scheduler, Meta + Cashfree wiring, smoke test

> **Status 2026-11-15:** local half done — Dockerfile (verified: /health, graceful SIGTERM), `.env.dev`/`.env.prod` split (`ENV=prod pnpm …`), RLS on all tables (applied), `docs/runbook.md`. Remaining: Cloud Run deploy (waiting for GCP project), real number + Meta webhook, Flow publish, Cashfree production keys, smoke test. Dropped while subscriptions are on hold: Cloud Scheduler `/jobs/daily`, `subscription_charge_failed` template, subscription smoke steps (`JOBS_SECRET` now optional). Message cleanup runs in pg_cron, not Scheduler.

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/runbook.md`
- Modify: `.env.example` (all env names incl. `PUBLIC_BASE_URL`, `NUTRIFARM_*`, `SEED_*`)

**Interfaces:**
- Consumes: everything above. Produces: a running production URL and `docs/runbook.md` describing each step below so it can be repeated for the next tenant.

- [ ] **Step 1: Dockerfile** — multi-stage `node:22-slim`; build with `pnpm build`; runtime runs `node dist/index.js`; `PORT` from env. Verify `docker build . && docker run -p 8080:8080 --env-file .env.local <img>` → `curl :8080/health` → `{"ok":true}`.
- [ ] **Step 2: Supabase** — create project in Mumbai region; copy the transaction-pooler URL into `DATABASE_URL`; run `pnpm db:migrate` and `pnpm tsx scripts/seed.ts`. Verify tables exist in Supabase table editor.
- [ ] **Step 3: Cloud Run** — `gcloud run deploy c2v-bot --source . --region asia-south1 --allow-unauthenticated --min-instances 0 --max-instances 2`, secrets via Secret Manager env bindings. Verify `/health` on the service URL.
- [ ] **Step 4: Meta wiring** (use the WhatsApp Business MCP tools on business `organic_nutri_farm`): confirm the phone number is linked; set webhook callback `https://<run-url>/webhooks/whatsapp` + verify token on app "C2V"; subscribe the WABA to the app (`messages` field); `order_delivered` was already submitted in Task 15 (language `en`, body: "Your order {{1}} has been delivered. Thank you for ordering from Organic Nutri Farm! 🥚"); create utility template `subscription_charge_failed` (body: "We couldn't collect payment for your egg delivery on {{1}}. This week's delivery is skipped. Reply *Hi* if you need help.") and wait for approval; Flows were already published in Tasks 8 and 13 (ids in `nutrifarm/config.ts`).
- [ ] **Step 5: Cashfree wiring** — sandbox first: set webhook URL `https://<run-url>/webhooks/cashfree` for payment links and subscriptions; later switch `CASHFREE_ENV=production` with production keys (UPI AutoPay must be enabled by Cashfree's team).
- [ ] **Step 6: Cloud Scheduler** — daily job at 06:00 IST: `POST https://<run-url>/jobs/daily` with header `x-jobs-secret`.
- [ ] **Step 7: Smoke test from a real phone** (sandbox payments): Hi → menu; Order Eggs → Flow → submit → Pay button → pay → confirmation; My Orders shows it; `scripts/orders.ts nutrifarm <orderCode> assign …` → `out-for-delivery` → `delivered` → template received; Subscribe → AutoPay link → approve → activation message; trigger `/jobs/daily` manually → logs summary. Record results in `docs/runbook.md`.
- [ ] **Step 8: Commit** `chore(deploy): dockerfile, runbook and production wiring`
