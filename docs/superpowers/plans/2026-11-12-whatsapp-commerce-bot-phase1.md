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
- Every business table has `tenant_id uuid not null` and every repo query filters by it.
- No Redis, no queue. Webhook handlers finish their work before responding.
- Payment link expiry: `30` minutes (tenant column `payment_link_expiry_minutes`, default 30).
- `message_retention_days` default `3`. `delivery_fee_paise` default `0`. `min_order_paise` default `0`.
- Order statuses exactly: `payment_pending | confirmed | assigned | out_for_delivery | delivered | cancelled | payment_failed | expired`.
- Subscription statuses exactly: `pending_authorization | active | cancelled | authorization_failed`.
- Graph API base: `https://graph.facebook.com/${GRAPH_API_VERSION}`; `GRAPH_API_VERSION` is an env var — set it to the latest stable version from Meta's changelog at implementation time.
- Cashfree base: sandbox `https://sandbox.cashfree.com/pg`, prod `https://api.cashfree.com/pg`; header `x-api-version: 2025-01-01`. Before coding each Cashfree call, confirm field names against cashfree.com/docs (API reference, latest) — the adapter interface in this plan is fixed, the wire format must match the docs.
- English only. All customer-facing copy lives in `src/tenants/<slug>/copy.ts`.
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
  tenants/types.ts                 # Tenant, TenantCopy
  tenants/tenant-repo.ts           # findTenantByPhoneNumberId, getTenant
  tenants/copy-registry.ts         # copyFor(tenant)
  tenants/nutrifarm/copy.ts        # NutriFarm message texts
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
  orders/order-service.ts          # createPendingOrder, confirmPaidOrder, updateStatus, refundOrder, expireStale
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
  publish-flows.ts                 # build & publish Flow JSON, store flow ids on tenant
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
- Produces: `Db` type (Drizzle instance, works for both postgres-js and PGlite); `createDb(url: string): Db` (postgres-js with `prepare: false` for the Supabase transaction pooler, `max: 5`); `createTestDb(): Promise<Db>` (PGlite + `migrate` from `src/db/migrations`); factories `seedTenant(db, overrides?) → Tenant`, `seedProduct(db, tenantId, overrides?)`, `seedPincode(db, tenantId, pincode, weekday)`, `seedCustomer(db, tenantId, overrides?)`.
- Tables (all `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`):
  - `tenants`: `slug` unique, `name`, `wa_phone_number_id` unique, `waba_id`, `wa_token_env` (env var name holding the access token), `cashfree_app_id_env`, `cashfree_secret_env`, `support_phone`, `order_prefix` (e.g. `NF`), `next_order_number int default 1001`, `order_flow_id` null, `subscribe_flow_id` null, `delivery_fee_paise int default 0`, `min_order_paise int default 0`, `payment_link_expiry_minutes int default 30`, `message_retention_days int default 3`, `subscription_charge_lead_days int default 2`.
  - `customers`: `tenant_id`, `wa_key` (= `user_id ?? wa_id`), `wa_id` null, `bsuid` null, `profile_name` null, `email` null, `default_address jsonb` null; unique(`tenant_id`,`wa_key`).
  - `products`: `tenant_id`, `sku`, `name`, `price_paise`, `active bool default true`, `sort_order int`; unique(`tenant_id`,`sku`).
  - `pincodes`: `tenant_id`, `pincode char(6)`, `delivery_weekday smallint` (0=Sun…6=Sat), `active bool default true`, `note` null; unique(`tenant_id`,`pincode`).
  - `orders`: `tenant_id`, `order_number text` unique per tenant, `customer_id`, `source` enum(`one_time`,`subscription`), `subscription_id` null, `status` enum (Global Constraints), `delivery_date date`, `address jsonb`, `pincode`, `subtotal_paise`, `delivery_fee_paise`, `total_paise`, `assigned_partner_id` null, `paid_at` null, `delivered_at` null, `updated_at`.
  - `order_items`: `order_id`, `product_id`, `name`, `unit_price_paise`, `quantity`, `line_total_paise`.
  - `payments`: `tenant_id`, `order_id`, `provider` (`cashfree`), `kind` enum(`link`,`subscription_charge`), `provider_ref` unique (link_id / charge payment_id), `amount_paise`, `status` enum(`created`,`paid`,`failed`,`expired`,`refunded`), `link_url` null, `raw jsonb` null, `updated_at`.
  - `subscriptions`: `tenant_id`, `customer_id`, `status` enum (Global Constraints), `address jsonb`, `pincode`, `delivery_weekday`, `per_delivery_total_paise`, `next_delivery_date date` null, `provider_subscription_id` unique, `auth_link` null, `updated_at`.
  - `subscription_items`: `subscription_id`, `product_id`, `quantity`.
  - `delivery_partners`: `tenant_id`, `name`, `phone`, `active`.
  - `messages`: `tenant_id`, `customer_id`, `direction` enum(`in`,`out`), `wa_message_id` unique null (outbound failures may have none), `type`, `text` null (human-readable summary), `payload jsonb`.
  - `Address` JSON shape: `{ name: string; line1: string; landmark?: string; pincode: string }`.

- [ ] **Step 1: Write failing test** `tests/db/schema.test.ts`: `createTestDb()` then insert a tenant + customer; inserting a second customer with the same (`tenant_id`,`wa_key`) rejects; inserting a message twice with the same `wa_message_id` rejects.
- [ ] **Step 2: Run** `pnpm test tests/db` → FAIL.
- [ ] **Step 3: Implement** `schema.ts`, `client.ts`, `drizzle.config.ts`; run `pnpm db:generate` to produce the first migration; implement `createTestDb` and factories.
- [ ] **Step 4: Run** `pnpm test tests/db` → PASS.
- [ ] **Step 5: Seed script** `scripts/seed.ts` (idempotent upserts) for NutriFarm: tenant `slug=nutrifarm`, `name='NutriFarm Eggs'`, `order_prefix='NF'`, `wa_phone_number_id`/`waba_id` from env `SEED_WA_PHONE_NUMBER_ID`/`SEED_WABA_ID`, token env name `NUTRIFARM_WA_TOKEN`, Cashfree env names `NUTRIFARM_CF_APP_ID`/`NUTRIFARM_CF_SECRET`, `support_phone` from `SEED_SUPPORT_PHONE`; products `EGG_W_6`, `EGG_W_12`, `EGG_W_30` (names "White Eggs – 6 pack" etc.; prices are read from `SEED_PRICE_EGG_W_6` etc. so real prices never live in git); pincode `560035` → weekday 3 (Wednesday). Run against a local Postgres or the Supabase dev project and verify rows exist.
- [ ] **Step 6: Commit** `feat(db): schema, migrations, test db helper and seed`

---

### Task 3: Domain utilities — money, pincode, delivery date

**Files:**
- Create: `src/domain/money.ts`, `src/domain/pincode.ts`, `src/domain/delivery-date.ts`
- Test: `tests/domain/*.test.ts`

**Interfaces:**
- Produces: `formatPaise(p: number): string`; `normalizePincode(raw: string): string | null`; `nextDeliveryDate(now: Date, weekday: number): string` (returns `YYYY-MM-DD` in IST); `formatDeliveryDate(isoDate: string): string` (e.g. `Wed, 18 Nov`).

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
- Create: `src/channels/whatsapp/signature.ts`, `src/channels/whatsapp/webhook-schema.ts`, `src/channels/whatsapp/parse.ts`, `src/tenants/types.ts`, `src/tenants/tenant-repo.ts`, `src/ingress/whatsapp-routes.ts`
- Modify: `src/app.ts` (mount routes)
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
      | { kind: 'other'; waType: string });
    ```
  - `parseWebhook(body: unknown): InboundMessage[]` — ignores `statuses`, `errors`, and non-`messages` fields; `from.bsuid` from `contacts[].user_id`, `from.waId` from `messages[].from`/`contacts[].wa_id` (either may be absent).
  - `Tenant` type (row of `tenants`); `findTenantByPhoneNumberId(db, id): Promise<Tenant | null>`.
  - `buildApp(deps, opts?: { onInbound?: (tenant: Tenant, msg: InboundMessage) => Promise<void> })`. Route `POST /webhooks/whatsapp` calls `onInbound(tenant, msg)` for each message (default wired to `handleInbound` in Task 7; tests inject a spy). Unknown tenant → log warn, still 200.
  - Route `GET /webhooks/whatsapp` echoes `hub.challenge` when `hub.mode=subscribe` and token matches, else 403.

- [ ] **Step 1: Fixtures** — save realistic payloads under `tests/fixtures/wa/`: `text.json`, `button-reply.json`, `list-reply.json`, `flow-nfm-reply.json`, `statuses-only.json`, `text-username-no-phone.json` (contacts has `user_id` + `profile.username`, no `wa_id`/`from`), `image.json`.
- [ ] **Step 2: Write failing tests**
  - parse: each fixture maps to the expected `kind`; `statuses-only.json` → `[]`; username fixture → `from.waId === null && from.bsuid === 'IN.…'`; `flow-nfm-reply` → `response` is the parsed `response_json` object and `flowToken` its `flow_token`.
  - signature: valid header → true; tampered body → false; missing header → false.
  - routes: GET with right token → 200 body = challenge; wrong token → 403. POST with bad signature → 401 and `onInbound` not called. POST statuses-only with good signature → 200, `onInbound` not called. POST text → `onInbound` called once with tenant resolved by `phone_number_id` (seed tenant in PGlite).
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
- Create: `src/channels/whatsapp/builders.ts`, `src/channels/whatsapp/sender.ts`, `src/tenants/copy-registry.ts`, `src/tenants/nutrifarm/copy.ts`, `tests/helpers/fakes.ts` (extend)
- Modify: `src/deps.ts` (type `whatsapp: WhatsAppSender`)
- Test: `tests/channels/whatsapp/builders.test.ts`, `tests/channels/whatsapp/sender.test.ts`

**Interfaces:**
- Produces:
  - Builders return the Graph `messages` body without `to`/`messaging_product`:
    `textMsg(body)`, `replyButtonsMsg(body, buttons: {id: string; title: string}[] /*1–3, title ≤20 chars*/)`, `ctaUrlMsg({ body, buttonText /*≤20*/, url, footer? })`, `flowMsg({ body, flowId, flowToken, cta /*≤20*/, screen, data })` (interactive `flow`, `flow_message_version: "3"`, `flow_action: "navigate"`, `flow_action_payload: { screen, data }`), `templateMsg(name, lang, bodyParams: string[])`.
  - `interface WhatsAppSender { send(tenant: Tenant, to: string, message: OutboundMessage): Promise<{ waMessageId: string }> }`.
  - `GraphWhatsAppSender(env, fetchImpl = fetch)` — POST `${base}/${tenant.wa_phone_number_id}/messages` with `Authorization: Bearer ${process.env[tenant.wa_token_env]}`; throws `WhatsAppSendError` (status + Meta error code) on non-2xx.
  - `sendAndLog(deps, tenant, customer, message, summaryText): Promise<void>` — sends via `deps.whatsapp` to `recipientOf(customer)` and calls `recordOutbound`; on send failure still records the outbound row with `waMessageId: null` and rethrows.
  - `TenantCopy` interface (in `tenants/types.ts`) with functions: `welcome(name: string|null)`, `help()`, `orderFlowIntro()`, `subscribeFlowIntro()`, `noItems()`, `invalidPincode(raw)`, `notServiceable(pincode)`, `orderSummary(o: {orderNumber; lines: {name; qty; lineTotal: string}[]; total: string; deliveryDate: string})`, `orderConfirmed({orderNumber; deliveryDate})`, `subscriptionSummary({lines; perDelivery: string; weekdayName: string; firstDelivery: string})`, `subscriptionActive({firstDelivery})`, `myOrders(rows: {orderNumber; status; deliveryDate; total}[], subs: {perDelivery; weekdayName; nextDelivery}[])`, `invalidEmail()`, `genericError()`. `copyFor(tenant: Tenant): TenantCopy` looks up by `tenant.slug`.
  - `FakeWhatsAppSender` records `{to, message}[]` and returns incrementing `wamid.fake.N`.

- [ ] **Step 1: Write failing tests** — builders produce exactly the Graph shapes (snapshot each builder once); `replyButtonsMsg` throws for >3 buttons or title >20 chars; `GraphWhatsAppSender` with a stub `fetchImpl` hits the right URL/headers and maps a 400 to `WhatsAppSendError`; `sendAndLog` writes one `messages` row with direction `out`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (NutriFarm copy: friendly, short, emoji-light; `orderSummary` ends with "Tap *Pay* below. The link is valid for 30 minutes.").
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): message builders, graph sender, tenant copy`

---

### Task 7: Bot router — menu, help, fallback

**Files:**
- Create: `src/bot/router.ts`, `src/bot/menu.ts`
- Modify: `src/app.ts` (wire `onInbound` → `handleInbound`)
- Test: `tests/bot/router.test.ts`

**Interfaces:**
- Consumes: `upsertCustomer`, `recordInbound`, `sendAndLog`, `copyFor`.
- Produces:
  - Button ids (constants in `router.ts`): `menu:order`, `menu:subscribe`, `menu:my_orders`, `menu:help`.
  - Flow token format: `${'order'|'subscribe'}:${customerId}:${randomId}`.
  - `handleInbound(deps, tenant, msg): Promise<void>`: upsert customer → `recordInbound` (return early if duplicate) → dispatch:
    - `button menu:order` → `sendOrderFlow` (Task 8); `menu:subscribe` → `sendSubscribeFlow` (Task 13); `menu:my_orders` → `sendMyOrders` (Task 12); `menu:help` → `sendHelp`.
    - `flow_submit` with token prefix `order:` → `onOrderFlowSubmit`; `subscribe:` → `onSubscribeFlowSubmit`.
    - anything else → `sendMenu`.
    - Any thrown error → log, `sendAndLog(copy.genericError())` (best effort), never rethrow (webhook must 200).
  - `sendMenu(deps, tenant, customer)`: reply buttons Order Eggs / Subscribe / My Orders with the welcome text; `sendHelp`: CTA-URL button `tel:+<support_phone>`.
  - Until Tasks 8/12/13 exist, those dispatch targets are stubs that call `sendMenu`; each later task replaces its stub.

- [ ] **Step 1: Write failing tests** (PGlite + FakeWhatsAppSender): text "hi" → one outbound reply-buttons message with ids above, inbound + outbound rows in `messages`; same inbound delivered twice → only one reply; `menu:help` → CTA with `tel:` URL; image message → menu; handler throwing → generic error sent and `handleInbound` resolves.
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
  - `buildOrderFlowJson(products: Pick<Product,'sku'>[]): object` — Flow JSON (latest version listed in Meta's Flow JSON changelog), no `data_api_version` (no endpoint). Screens:
    - `PRODUCTS`: for each product a `Dropdown` named `qty_<sku>` with options `"0"`…`"10"`, `init-value "0"`, `label: "${data.label_<sku>}"`; footer "Next" → `navigate` to `ADDRESS` passing all `qty_*`.
    - `ADDRESS` (terminal): `TextInput name` (required), `TextArea line1` (required), `TextInput landmark` (optional), `TextInput pincode` (required, `input-type: number`), each with `init-value` bound to `${data.prefill_*}`; footer "Continue" → `complete` with payload of all `qty_*` + address fields.
    - Screen `data` declarations include `__example__` values for every bound key.
  - `orderFlowData(products: Product[], prefill: Address | null): Record<string, string>` → `{ label_<sku>: "<name> — ₹<price>", prefill_name, prefill_line1, prefill_landmark, prefill_pincode }` (empty strings when no prefill).
  - `publishFlow(env, tenant, name: string, flowJson: object): Promise<string /*flow id*/>` — `POST /{waba_id}/flows` with `name`, `categories: ["SHOPPING"]`, `flow_json`, `publish: true` (confirm field names in the Flows API reference).
  - `scripts/publish-flows.ts <tenantSlug>` builds both flows (subscribe flow arrives in Task 13; until then only order), publishes, writes ids to `tenants.order_flow_id` / `subscribe_flow_id`. Re-run whenever products are added/removed (labels/prices are dynamic and need no republish).
  - `sendOrderFlow(deps, tenant, customer)`: `flowMsg({ body: copy.orderFlowIntro(), flowId: tenant.order_flow_id, flowToken: 'order:<customerId>:<nanoid>', cta: 'Order now', screen: 'PRODUCTS', data: orderFlowData(...) })`.

- [ ] **Step 1: Write failing tests** — `buildOrderFlowJson` for skus `[A,B]` contains dropdowns `qty_A`, `qty_B`, ADDRESS footer `complete` payload has keys `qty_A, qty_B, name, line1, landmark, pincode`; every `${data.x}` reference has a matching `__example__`. `orderFlowData` label for price 9000 = `"White Eggs – 6 pack — ₹90"`. `sendOrderFlow` sends a flow message whose token starts with `order:<customerId>:` and whose data prefill comes from `customer.default_address`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Validate for real:** run `pnpm tsx scripts/publish-flows.ts nutrifarm` against the real WABA (needs `NUTRIFARM_WA_TOKEN`); confirm publish succeeds and the Flow renders when sent to your own phone (temporarily wire `menu:order`).
- [ ] **Step 6: Commit** `feat(flows): order flow json, publisher script and flow send`

---

### Task 9: Order creation from Flow submit (validation + pending order)

**Files:**
- Create: `src/orders/order-repo.ts`, `src/orders/order-service.ts` (create part)
- Modify: `src/bot/order-flow-handler.ts` (submit part, payment step stubbed until Task 11)
- Test: `tests/orders/order-service.create.test.ts`, `tests/bot/order-flow-submit.test.ts`

**Interfaces:**
- Produces:
  - `parseOrderSubmission(response: Record<string, unknown>, products: Product[]): { lines: {product: Product; quantity: number}[]; address: Address } | { error: 'no_items' | 'invalid_pincode' ; raw?: string }` — ignores unknown `qty_*` keys and non-integer/negative values (treated as 0); pincode via `normalizePincode`.
  - `createPendingOrder(deps, tenant, customer, input: { lines; address; source: 'one_time' | 'subscription'; subscriptionId?: string; deliveryDate: string }): Promise<OrderWithItems>` — in one transaction: `UPDATE tenants SET next_order_number = next_order_number + 1 RETURNING` → `order_number = ${order_prefix}-${n}`; totals: `subtotal = Σ unit_price × qty` using **DB prices**, `delivery_fee = tenant.delivery_fee_paise`, `total = subtotal + fee`; status `payment_pending`.
  - `OrderWithItems = Order & { items: OrderItem[] }`; repo: `findOrderById`, `findOrderByNumber(db, tenantId, number)`, `listRecentOrders(db, tenantId, customerId, limit)`.
  - `onOrderFlowSubmit(deps, tenant, customer, msg)`: parse → on `no_items` send `copy.noItems()`; on invalid pincode send `copy.invalidPincode(raw)`; pincode not in `pincodes` (active) → `copy.notServiceable(pincode)`; else save default address, compute `nextDeliveryDate(deps.now(), pincode.delivery_weekday)`, `createPendingOrder`, then `startPayment` (Task 11; stub sends the summary text without a button for now).

- [ ] **Step 1: Write failing tests** — all-zero quantities → `noItems` message, zero orders in DB; pincode `" 560 035"` accepted; `"56003"` → invalid message; serviceable but unknown pincode `110001` → notServiceable; valid submit (2×6-pack @ ₹90, 1×30-pack @ ₹420) → order `NF-1001`, `total_paise = 60000`, delivery date = next Wednesday from fixed clock, two `order_items`, address saved as customer default; second order → `NF-1002`; a tampered price in the submission is ignored (DB price used).
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
    createPaymentLink(t: Tenant, i: { linkId: string; amountPaise: number; purpose: string;
      customerPhone: string | null; customerName: string | null; expiresAt: Date; notifyUrl: string }): Promise<{ linkId: string; url: string }>;
    getPaymentLink(t: Tenant, linkId: string): Promise<{ status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'PARTIALLY_PAID'; amountPaidPaise: number }>;
    refundPaymentLink(t: Tenant, linkId: string, amountPaise: number, refundId: string): Promise<void>;
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
  - `CashfreeProvider(env, fetchImpl = fetch)` reads `process.env[tenant.cashfree_app_id_env]` / `[cashfree_secret_env]`; sends `x-client-id`, `x-client-secret`, `x-api-version: 2025-01-01`. Amounts converted paise ↔ rupees only inside the adapter. `customerPhone` null → omit (customers with BSUID only).
  - Payment repo: `insertPayment`, `findPaymentByProviderRef`, `markPayment(db, id, status, raw)`.
  - `FakePaymentProvider` lets tests set link status/amount and records calls.

- [ ] **Step 1: Write failing tests** — client: `createPaymentLink` posts to `/links` with amount `480.00` for 48000 paise, expiry ISO string, `link_notify` off, notify URL in `link_meta`; maps response `link_url`; `getPaymentLink` maps status + amount to paise. webhook: valid signature true; wrong secret false; missing headers false; payment-link fixture → `{type:'link_paid', linkId}`; unknown event → `ignored`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (check each field against Cashfree docs before writing). **Step 4: Run** → PASS.
- [ ] **Step 5: Sandbox check:** small script call `createPaymentLink` with sandbox creds, open the URL, pay with sandbox UPI, confirm `getPaymentLink` → PAID.
- [ ] **Step 6: Commit** `feat(payments): cashfree payment links, webhook verification and refunds`

---

### Task 11: Checkout end to end — Pay button, Cashfree webhook, confirmation

**Files:**
- Create: `src/ingress/cashfree-routes.ts`
- Modify: `src/orders/order-service.ts` (`startPayment`, `confirmPaidOrder`), `src/bot/order-flow-handler.ts` (replace stub), `src/app.ts`
- Test: `tests/orders/checkout.test.ts`, `tests/ingress/cashfree-routes.test.ts`

**Interfaces:**
- Produces:
  - `startPayment(deps, tenant, customer, order: OrderWithItems): Promise<void>` — `linkId = order.id` (uuid, unique), `expiresAt = now + tenant.payment_link_expiry_minutes`, `notifyUrl = ${PUBLIC_BASE_URL}/webhooks/cashfree` (add `PUBLIC_BASE_URL` to `Env`); insert `payments` row (`kind: link`, `created`); send `ctaUrlMsg({ body: copy.orderSummary(...), buttonText: 'Pay ₹<total>', url })`.
  - `confirmPaidOrder(deps, tenant, linkId): Promise<'confirmed' | 'already' | 'not_paid' | 'amount_mismatch'>` — loads payment by `provider_ref`; if order not `payment_pending` → `already`; calls `getPaymentLink`; requires `status === 'PAID'` and `amountPaidPaise === order.total_paise`; then in one transaction payment → `paid`, order → `confirmed`, `paid_at = now`; then sends `copy.orderConfirmed`. Mismatch → log error, payment stays, returns `amount_mismatch`.
  - Route `POST /webhooks/cashfree`: verify signature with the tenant's secret (tenant resolved from the payment row of `linkId`/subscription id; unknown ref → 200 + warn); bad signature → 401; dispatch `link_*` → `confirmPaidOrder`; subscription events → Task 14 handlers (stub → 200). Always 200 after handling, including handler errors (logged), so Cashfree does not hammer retries for bugs; the daily job reconciles.

- [ ] **Step 1: Write failing tests** — flow submit → outbound CTA with `Pay ₹600` and the fake link URL, `payments` row `created`; webhook with valid signature + fake link PAID → order `confirmed`, one confirmation message containing `NF-1001` and `Wed, 18 Nov`; same webhook again → `already`, still exactly one confirmation; fake link `ACTIVE` → `not_paid`, order stays pending; amount 59900 → `amount_mismatch`, order stays pending; bad signature → 401, nothing changes.
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

**Files:**
- Create: `src/subscriptions/subscription-service.ts`, `src/bot/subscribe-flow-handler.ts`
- Modify: `src/channels/whatsapp/flows.ts` (`buildSubscribeFlowJson`), `scripts/publish-flows.ts`, `src/payments/provider.ts` + `src/payments/cashfree/client.ts` (subscription methods), `src/ingress/cashfree-routes.ts`, `src/bot/router.ts`
- Test: `tests/subscriptions/create.test.ts`, `tests/channels/whatsapp/subscribe-flow.test.ts`

**Interfaces:**
- Produces:
  - `PaymentProvider` additions:
    ```ts
    createSubscription(t: Tenant, i: { subscriptionId: string; maxAmountPaise: number; customer: { name: string; email: string; phone: string | null };
      returnUrl: string; notifyUrl: string }): Promise<{ providerSubscriptionId: string; authLink: string }>;
    getSubscription(t: Tenant, providerSubscriptionId: string): Promise<{ status: 'ACTIVE' | 'INITIALIZED' | 'BANK_APPROVAL_PENDING' | 'CANCELLED' | 'FAILED' | string }>;
    raiseCharge(t: Tenant, i: { providerSubscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string }): Promise<void>;
    cancelSubscription(t: Tenant, providerSubscriptionId: string): Promise<void>;
    ```
    Cashfree plan type `ON_DEMAND`, payment method UPI. `maxAmountPaise = 2 × per_delivery_total` (headroom for price changes without a new mandate).
  - `buildSubscribeFlowJson(products)`: `PRODUCTS` screen identical to the order flow (labels say "per week"), then `DETAILS` terminal screen = ADDRESS fields + `TextInput email` (`input-type: email`, required). Complete payload adds `email`.
  - `sendSubscribeFlow(deps, tenant, customer)` — token `subscribe:<customerId>:<id>`.
  - `onSubscribeFlowSubmit(deps, tenant, customer, msg)`: reuse `parseOrderSubmission` + pincode checks; email must match `^[^@\s]+@[^@\s]+\.[^@\s]+$` else `copy.invalidEmail()`; save email + default address; insert `subscriptions` (`pending_authorization`, `delivery_weekday` from pincode, `per_delivery_total_paise`) + `subscription_items`; `createSubscription`; store `provider_subscription_id`, `auth_link`; send `ctaUrlMsg({ body: copy.subscriptionSummary(...), buttonText: 'Set up AutoPay', url: authLink })`.
  - `onSubscriptionStatus(deps, tenant, providerSubscriptionId)`: `getSubscription` (never trust the webhook alone); `ACTIVE` and local `pending_authorization` → set `active`, `next_delivery_date = nextDeliveryDate(now, weekday)`, send `copy.subscriptionActive`; `CANCELLED`/`FAILED` while pending → `authorization_failed`; idempotent.

- [ ] **Step 1: Failing tests** — subscribe flow JSON has `email` field and complete payload includes it; invalid email → invalidEmail message, no subscription row; valid submit → subscription `pending_authorization`, items saved, CTA "Set up AutoPay" with fake auth link, fake provider received `maxAmountPaise = 2 × total`; status webhook (fake ACTIVE) → `active`, `next_delivery_date` = next weekday, one activation message; repeated webhook → no second message.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (verify Cashfree subscription field names in docs; republish flows via script). **Step 4: Run** → PASS.
- [ ] **Step 5: Sandbox check** — create a sandbox subscription, open auth link, approve, confirm webhook → active.
- [ ] **Step 6: Commit** `feat(subscriptions): subscribe flow, upi autopay mandate creation and activation`

---

### Task 14: Daily job — subscription charges, charge results, expiry, retention, DB size

**Files:**
- Create: `src/jobs/daily.ts`, `src/ingress/jobs-routes.ts`
- Modify: `src/subscriptions/subscription-service.ts` (`raiseDueCharges`, `onChargeResult`), `src/orders/order-service.ts` (`expireStalePendingOrders`), `src/ingress/cashfree-routes.ts`, `src/app.ts`
- Test: `tests/jobs/daily.test.ts`, `tests/subscriptions/charges.test.ts`

**Interfaces:**
- Produces:
  - `raiseDueCharges(deps, tenant): Promise<number>` — for `active` subscriptions with `next_delivery_date <= today + tenant.subscription_charge_lead_days`: create order via `createPendingOrder` (`source: subscription`, `deliveryDate: next_delivery_date`, items from `subscription_items` at **current** prices), insert `payments` (`kind: subscription_charge`, `provider_ref = order.id`), `raiseCharge({ paymentId: order.id, amountPaise: order.total_paise, scheduleDate: next_delivery_date − 1 day })`, then advance `next_delivery_date += 7`. Idempotent per (subscription, delivery date): skip if an order already exists for that pair.
  - `onChargeResult(deps, tenant, paymentId, success)`: success → payment `paid`, order `confirmed` (no message — weekly spam is unwanted); failure → payment `failed`, order `payment_failed`, send template `subscription_charge_failed` with params `[deliveryDate]`. Idempotent.
  - `expireStalePendingOrders(deps, tenant): Promise<number>` — one-time `payment_pending` orders older than `payment_link_expiry_minutes` whose link `getPaymentLink` is not PAID → order `expired`, payment `expired`; if PAID (missed webhook) → `confirmPaidOrder`.
  - `runDailyJob(deps): Promise<{ tenants: number; charges: number; expired: number; purged: number; dbBytes: number }>` — per tenant: `raiseDueCharges`, `expireStalePendingOrders`, `purgeMessagesOlderThan(retention)`; then `select pg_database_size(current_database())`, log **warn** when > 400 MB.
  - Route `POST /jobs/daily` requires header `x-jobs-secret === env.JOBS_SECRET` (else 401); returns the summary JSON.

- [ ] **Step 1: Failing tests** (fixed clock Thu 2026-11-12 IST, lead 2 days): active subscription with next delivery Wed 18 Nov → not charged on 12 Nov; clock 16 Nov → one order `NF-…` (`source: subscription`, delivery `2026-11-18`), `raiseCharge` scheduleDate `2026-11-17`, next date becomes `2026-11-25`; running twice on 16 Nov → still one order. Charge success → order `confirmed`, no outbound message; failure → `payment_failed` + template `subscription_charge_failed` sent. Pending one-time order 31 min old with link ACTIVE → `expired`; with link PAID → `confirmed`. Messages older than retention purged. `/jobs/daily` without secret → 401.
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
  - `updateStatus(deps, tenant, orderId, to: 'assigned' | 'out_for_delivery' | 'delivered' | 'cancelled', opts?: { partnerId?: string }): Promise<Order>` — `assigned` requires an active `partnerId`; `delivered` sets `delivered_at` and sends template `order_delivered` with params `[orderNumber]` to the customer; other transitions send nothing.
  - `refundOrder(deps, tenant, orderId): Promise<void>` — only for one-time orders with a `paid` link payment; calls `refundPaymentLink` (refund id = `refund-<orderId>`), payment → `refunded`, order → `cancelled` if not delivered. Subscription-charge refunds are out of scope (throw `NotSupportedError`).
  - `cancelSubscription(deps, tenant, subscriptionId): Promise<void>` (in `subscription-service.ts`) — provider `cancelSubscription`, status → `cancelled`, `next_delivery_date = null`; already-raised orders are untouched.
  - CLI: `pnpm tsx scripts/orders.ts <tenantSlug> <orderNumber> assign <partnerPhone> | out-for-delivery | delivered | cancel | refund`, and `pnpm tsx scripts/orders.ts <tenantSlug> sub <subscriptionId> cancel`. Phase 2 dashboard calls these same service functions.

- [ ] **Step 1: Failing tests** — confirmed → assigned (with partner) → out_for_delivery → delivered sends exactly one `order_delivered` template; `payment_pending → delivered` throws; assign without partner throws; refund of paid one-time order calls provider once and marks payment `refunded`; refund of unpaid order throws.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(orders): status transitions, delivered template, refund and ops cli`

---

### Task 16: Deployment — Docker, Cloud Run, Scheduler, Meta + Cashfree wiring, smoke test

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/runbook.md`
- Modify: `.env.example` (all env names incl. `PUBLIC_BASE_URL`, `NUTRIFARM_*`, `SEED_*`)

**Interfaces:**
- Consumes: everything above. Produces: a running production URL and `docs/runbook.md` describing each step below so it can be repeated for the next tenant.

- [ ] **Step 1: Dockerfile** — multi-stage `node:22-slim`; build with `pnpm build`; runtime runs `node dist/index.js`; `PORT` from env. Verify `docker build . && docker run -p 8080:8080 --env-file .env.local <img>` → `curl :8080/health` → `{"ok":true}`.
- [ ] **Step 2: Supabase** — create project in Mumbai region; copy the transaction-pooler URL into `DATABASE_URL`; run `pnpm db:migrate` and `pnpm tsx scripts/seed.ts`. Verify tables exist in Supabase table editor.
- [ ] **Step 3: Cloud Run** — `gcloud run deploy c2v-bot --source . --region asia-south1 --allow-unauthenticated --min-instances 0 --max-instances 2`, secrets via Secret Manager env bindings. Verify `/health` on the service URL.
- [ ] **Step 4: Meta wiring** (use the WhatsApp Business MCP tools on business `organic_nutri_farm`): confirm the phone number is linked; set webhook callback `https://<run-url>/webhooks/whatsapp` + verify token on app "C2V"; subscribe the WABA to the app (`messages` field); create utility templates `order_delivered` (body: "Your order {{1}} has been delivered. Thank you for choosing NutriFarm! 🥚") and `subscription_charge_failed` (body: "We couldn't collect payment for your egg delivery on {{1}}. This week's delivery is skipped. Reply *Hi* if you need help.") and wait for approval; run `scripts/publish-flows.ts nutrifarm`.
- [ ] **Step 5: Cashfree wiring** — sandbox first: set webhook URL `https://<run-url>/webhooks/cashfree` for payment links and subscriptions; later switch `CASHFREE_ENV=production` with production keys (UPI AutoPay must be enabled by Cashfree's team).
- [ ] **Step 6: Cloud Scheduler** — daily job at 06:00 IST: `POST https://<run-url>/jobs/daily` with header `x-jobs-secret`.
- [ ] **Step 7: Smoke test from a real phone** (sandbox payments): Hi → menu; Order Eggs → Flow → submit → Pay button → pay → confirmation; My Orders shows it; `scripts/orders.ts nutrifarm NF-1001 assign …` → `out-for-delivery` → `delivered` → template received; Subscribe → AutoPay link → approve → activation message; trigger `/jobs/daily` manually → logs summary. Record results in `docs/runbook.md`.
- [ ] **Step 8: Commit** `chore(deploy): dockerfile, runbook and production wiring`
