# Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers subscribe on WhatsApp (weekly, every 2 weeks or every 4 weeks), approve a UPI AutoPay mandate,
get an upcoming order plus an "upcoming charge" message with a Skip button two days before every delivery, and the order
is confirmed when the charge is collected the next day; the vendor sees and cancels subscriptions from the dashboard.

**Architecture:** A new `src/subscriptions/` module (create, activate, raise charges, charge results, skip, cancel)
behind the existing `PaymentProvider` port, which gains Cashfree subscription methods. The bot gets a Subscribe Flow
and a template quick-reply handler; the server gets `GET /subscribe/:token` (authorisation page) and
`POST /jobs/subscription-charges` (hourly job). The admin API gains three subscription routes.

**Tech Stack:** existing: Node 22, TypeScript strict, Hono, drizzle-orm + node-postgres, zod 4, vitest + PGlite,
pino. Cashfree Subscriptions API `2026-01-01` (`/pg/subscriptions…`), WhatsApp Cloud API templates and Flows.

**Spec:** `docs/superpowers/specs/2026-11-12-whatsapp-commerce-bot-design.md` §10 (binding), plus
`docs/admin-api.md` for the dashboard contract.

## Global Constraints

- Work on branch `feat/subscriptions`. One task = one reviewed commit, 2–3 line message, only after the user approves.
- Money in integer paise; Cashfree amounts are rupees with 2 decimals (convert at the adapter boundary only).
- Dates are IST calendar days `YYYY-MM-DD`; use `src/domain/delivery-date.ts` helpers, never `new Date()` maths inline.
- Frequency step days exactly: weekly 7, biweekly 14, monthly 28 (`frequencyStepDays`).
- Mandate max = `2 × per_delivery_total_paise`. Charges use **current** product prices + current delivery fee.
- Our `subscriptions.id` (uuid) is the Cashfree `subscription_id`; our `payments.id` (uuid) is the Cashfree `payment_id`
  and is stored in `payments.provider_ref`.
- Never trust a Cashfree webhook body: re-fetch the subscription or payment before changing state. All handlers are
  idempotent (webhooks repeat; the job runs hourly).
- Template names/languages exactly: `subscription_upcoming_charge` (`en`, body params `[amount e.g. "258", date e.g. "Wed, 18 Nov"]`,
  quick-reply payload `skip:<paymentId>`), `subscription_charge_failed` (`en`, body param `[date]`).
- Customer-facing text lives in `TenantCopy` (`src/tenants/types.ts` + `src/tenants/nutrifarm/copy.ts`).
- Admin routes follow `docs/admin-api.md` conventions (tenant from session, 404 for other tenants, zod 400s); the
  contract is updated in the same commit and re-copied to the dashboard repo (local, uncommitted there).
- No secrets in commits; run `bash .superpowers/secret-check.sh` before each commit. Never stage `CLIENT_CHECKLIST.md` / `LEARNING.md`.

## Review Focus

1. Duplicate effects from repeated webhooks or overlapping hourly runs: two orders for one cycle, two upcoming
   messages, two failure templates. Every handler must be idempotent; tests send each webhook twice.
2. Skip racing the collection: a tap after Cashfree has already debited (webhook not yet arrived) must not cancel
   the order. Skip trusts only Cashfree's cancel result and re-fetch; already collected → order confirmed + "already paid, contact us".
3. Timing edges: activation late in the evening, a delivery date already too close to charge, D-1 already past,
   month/year rollovers, IST vs UTC around midnight.
4. Mandate revoked or paused from the customer's UPI app between cycles: no charge raised, local state follows.
5. A product deactivated or repriced after subscribing: the charge uses current prices for still-active products and
   skips removed ones; an empty basket (all removed) skips the cycle with a log, never a ₹0 charge or an empty order.

Each item has a test in the owning task (T4/T5/T6/T7).

---

### Task 1: Foundations — schema, dates, copy, template messages, quick-reply inbound, templates submitted

**Files:**
- Modify: `src/db/schema.ts` (+ new migration via `pnpm db:generate`), `src/domain/delivery-date.ts`,
  `src/tenants/types.ts`, `src/tenants/nutrifarm/copy.ts`, `src/channels/whatsapp/builders.ts`,
  `src/channels/whatsapp/webhook-schema.ts`, `src/channels/whatsapp/parse.ts`
- Create: `scripts/templates.ts` (+ `package.json` script `templates:create`)
- Test: `tests/domain/delivery-date.test.ts`, `tests/channels/whatsapp/builders.test.ts`, `tests/channels/whatsapp/parse.test.ts`, `tests/tenant-copy.test.ts`

**Interfaces:**
- Produces:
  - Migration: `payment_status` enum gains `cancelled`; `subscriptions` gains `cf_session_id text` (nullable) and
    `auth_token text unique` (nullable; random 43-char token for the authorisation page URL).
  - `firstSubscriptionDelivery(now: Date, weekday: number): string` — rule in spec §10 "First delivery".
  - `frequencyLabel(f: Frequency, weekday: number): string` → `'every Wednesday' | 'every 2 weeks on Wednesday' | 'every 4 weeks on Wednesday'`.
  - `templateMsg(name, lang, bodyParams, opts?: { quickReplyPayloads?: string[] })` — adds
    `{ type: 'button', sub_type: 'quick_reply', index: i, parameters: [{ type: 'payload', payload }] }` per payload.
  - `InboundMessage` button variant also produced for template quick replies (`m.type === 'button'`,
    `m.button.payload` → `replyId`, `m.button.text` → `title`).
  - `TenantCopy` additions: `subscribeFlowIntro` (reworded for frequencies), `subscriptionSummary({ lines, perDelivery, frequency, firstDelivery })`,
    `subscriptionActive({ firstDelivery, frequency })`, `subscriptionAuthFailed()`, `skipDone({ date, next })`,
    `skipAlreadyPaid({ orderCode, supportPhone })`, `skipProcessing({ supportPhone })`, `subscriptionCancelled()`
    (`supportPhone: string | null` from tenant settings; null → "reply Help" wording); `myOrders` subs rows take `frequency` instead of `weekdayName`.
  - `pnpm templates:create <tenant> [--test-number]` — creates `subscription_upcoming_charge` and
    `subscription_charge_failed` (spec §10 wording) if absent; prints each template's status.

- [ ] **Step 1: Failing tests** — `firstSubscriptionDelivery`: Mon 16 Nov 10:00 IST, weekday Wed → `2026-11-18`;
  Mon 16 Nov 20:30 IST, weekday Wed → `2026-11-25`; Tue 17 Nov 09:00, weekday Wed → `2026-11-25`;
  Wed 30 Dec 10:00, weekday Fri → `2027-01-01`. `frequencyLabel` for all three. `templateMsg` with one payload
  produces the button component; without payloads output is unchanged. Parse a template quick-reply webhook
  fixture → `{ kind: 'button', replyId: 'skip:<uuid>', title: 'Skip this delivery' }`.
- [ ] **Step 2: Run** `pnpm vitest run tests/domain tests/channels tests/tenant-copy.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `pnpm db:generate` for the migration; apply to Supabase with `pnpm db:migrate` (ask the user first, as before).
- [ ] **Step 4: Run** full suite + typecheck → PASS.
- [ ] **Step 5: Submit templates** — `pnpm templates:create nutrifarm` and `--test-number`; report statuses (approval runs in parallel with later tasks).
- [ ] **Step 6: Commit** `feat(subscriptions): schema, dates, copy and template quick replies`

---

### Task 2: Cashfree subscription adapter

**Files:**
- Modify: `src/payments/provider.ts`, `src/payments/cashfree/client.ts`, `tests/helpers/fakes.ts`
- Create: `scripts/cashfree-subs-check.ts` (+ `package.json` script `cashfree:subs-check`)
- Test: `tests/payments/cashfree-subscriptions.test.ts`

**Interfaces:**
- Produces (`PaymentProvider` additions; Cashfree statuses passed through as strings):
  ```ts
  createSubscription(t, i: { subscriptionId: string; maxAmountPaise: number; expiresAt: Date;
    customer: { name: string; email: string; phone: string }; returnUrl: string }): Promise<{ cfSubscriptionId: string; sessionId: string }>;
  getSubscription(t, subscriptionId: string): Promise<{ status: string }>;
  raiseCharge(t, i: { subscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string }): Promise<void>;
  getCharge(t, subscriptionId: string, paymentId: string): Promise<{ status: string }>;   // INITIALIZED|PENDING|SUCCESS|FAILED|CANCELLED
  cancelCharge(t, subscriptionId: string, paymentId: string): Promise<void>;
  cancelSubscription(t, subscriptionId: string): Promise<void>;
  ```
  `createSubscription` uses an inline `ON_DEMAND` plan (`plan_max_amount` = max) if Cashfree accepts inline plans,
  otherwise creates plan `p-<subscriptionId without dashes>` first; payment method UPI; `subscription_expiry_time` = `expiresAt`
  (subscribe time + 10 years). `scheduleDate` is sent as that IST day at 10:00 IST in ISO form. Idempotency: a 409
  "already exists" on create/raise is treated as success after a re-fetch.
  `FakePaymentProvider` records each call and lets tests set statuses and failures.

- [ ] **Step 1: Failing tests** with a stubbed `fetch`: request paths/bodies/headers for each method (amounts in
  rupees, schedule date format, plan type), error mapping to `ProviderError` without PII, 409 on raise treated as success.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (verify field names against Cashfree docs via the `subscriptions` skill). **Step 4: Run** → PASS.
- [ ] **Step 5: Sandbox check** — `pnpm cashfree:subs-check create|status|charge|cancel-charge|cancel` against sandbox:
  create a subscription, approve via the sandbox checkout, raise a charge, cancel a not-yet-collected charge (records
  how late a cancel is allowed), cancel the subscription. Report the observed statuses and webhook types in the task report.
- [ ] **Step 6: Commit** `feat(payments): cashfree subscriptions, charges and cancels`

---

### Task 3: Subscribe Flow — JSON, sending, publishing (draft on the test number)

**Files:**
- Modify: `src/channels/whatsapp/flows.ts`, `src/bot/handlers.ts` (replace the coming-soon stub), `scripts/publish-flows.ts`, `src/tenants/nutrifarm/config.ts`
- Create: `src/bot/subscribe-flow-handler.ts` (send half)
- Test: `tests/channels/whatsapp/subscribe-flow.test.ts`, `tests/bot/subscribe-flow-send.test.ts`

**Interfaces:**
- Produces:
  - `buildSubscribeFlowJson()`: `PRODUCTS` screen identical to the order Flow's 8 slots (labels "per delivery"),
    plus a `RadioButtonsGroup` `frequency` (`weekly` "Every week", `biweekly` "Every 2 weeks", `monthly` "Every 4 weeks", required, default weekly),
    then `DETAILS` terminal screen = the order Flow's address fields + `TextInput email` (`input-type: email`, required),
    phone field shown only when `ask_phone`. Complete payload adds `frequency` and `email`.
  - `encodeSubscribeFlowToken(customerId, slotMap)` / `decodeSubscribeFlowToken` — `subscribe:` prefix, same shape as the order token.
  - `sendSubscribeFlow(deps, tenant, customer)` — like `sendOrderFlow`; if `flows.subscribeFlowId` is empty, keep the coming-soon reply.
  - `pnpm flows:publish <tenant> --kind subscribe [--draft] [--test-number] [--flow-id] [--update-json]` (`--kind` defaults to `order`).
  - Tenant config: `subscribeFlowId` from env `NUTRIFARM_SUBSCRIBE_FLOW_ID` (empty default), so the test-number draft id can be set in `.env.dev`.

- [ ] **Step 1: Failing tests** — JSON has the `frequency` radio and `email` input and every screen/field Meta needs; token round-trips
  and rejects another prefix; send uses the subscribe flow id and prefilled address; empty flow id → coming-soon text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Draft on the test number** — `pnpm flows:publish nutrifarm --kind subscribe --draft --test-number`; set the id in `.env.dev`;
  user opens the Flow from WhatsApp (draft flows open only for the WABA's testers) and checks the screens.
- [ ] **Step 6: Commit** `feat(subscriptions): subscribe flow with frequency and email`

---

### Task 4: Subscribe submit → pending subscription → authorisation page → "Set up AutoPay"

**Files:**
- Modify: `src/bot/subscribe-flow-handler.ts` (submit half), `src/bot/handlers.ts`, `src/app.ts`
- Create: `src/subscriptions/subscription-service.ts` (`createSubscription`), `src/subscriptions/subscription-repo.ts`, `src/ingress/subscribe-page.ts`
- Test: `tests/subscriptions/create.test.ts`, `tests/ingress/subscribe-page.test.ts`

**Interfaces:**
- Consumes: T1 copy/dates, T2 `createSubscription`, T3 token decode.
- Produces:
  - `onSubscribeFlowSubmit(deps, tenant, customer, msg)`: reuse `parseOrderSubmission` (+ `frequency` ∈ the three values, else `invalidAddress`),
    email regex `^[^@\s]+@[^@\s]+\.[^@\s]+$` else `copy.invalidEmail()`, BSUID phone rule, minimum order, serviceable pincode;
    save email + default address; insert `subscriptions` (`pending_authorization`, frequency, `delivery_weekday` from pincode,
    `per_delivery_total_paise` = items at current prices + delivery fee, `location` = customer default, `auth_token`) + `subscription_items`;
    provider `createSubscription`; store `cf_subscription_id`, `cf_session_id`; send `ctaUrlMsg({ body: copy.subscriptionSummary(...), buttonText: 'Set up AutoPay', url: <PUBLIC_BASE_URL>/subscribe/<auth_token> })`.
    Provider failure → subscription row deleted (with items) and `copy.genericError()`.
  - `GET /subscribe/:token` — 43-char token shape check first (404 otherwise, no DB hit); `pending_authorization` → HTML page that loads
    `https://sdk.cashfree.com/js/v3/cashfree.js` (mode from `CASHFREE_ENV`) and calls `subscriptionsCheckout({ subsSessionId, redirectTarget: '_self' })`;
    any other status → short "This link is no longer active. Go back to WhatsApp." page. Headers `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
    `GET /subscribe/:token/done` — Cashfree `return_url`: "All set. You can close this page and return to WhatsApp."

- [ ] **Step 1: Failing tests** — valid submit → one `pending_authorization` row, items saved, fake provider got max = 2 × total and
  the customer's email/phone, CTA url ends with `/subscribe/<token>`; invalid email / below minimum / unserviceable → message and no row;
  provider failure → no row left, generic error; page: good token → HTML containing the session id and the sandbox mode; active
  subscription token → inactive page; junk token → 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(subscriptions): subscribe submit, mandate creation and authorisation page`

---

### Task 5: Mandate status — activation, auth failure, customer pause/cancel

**Files:**
- Modify: `src/subscriptions/subscription-service.ts`, `src/ingress/cashfree-routes.ts`
- Test: `tests/subscriptions/status.test.ts`, `tests/ingress/cashfree-routes.test.ts`

**Interfaces:**
- Produces: `onSubscriptionStatus(deps, tenant, subscriptionId): Promise<'activated' | 'auth_failed' | 'cancelled' | 'unchanged'>` —
  re-fetch with `getSubscription`; mapping per spec §10 "Mandate changes"; on activation set `next_delivery_date = firstSubscriptionDelivery(now, weekday)`
  and send `copy.subscriptionActive`; on auth failure send `copy.subscriptionAuthFailed()` (customer can subscribe again);
  on remote cancel set `cancelled`, `next_delivery_date` null, cancel future `created` charges via `cancelCharge` (payment and its order → `cancelled`), send `copy.subscriptionCancelled()`.
  `CUSTOMER_PAUSED` / `BANK_APPROVAL_PENDING` → `unchanged`. The Cashfree route dispatches `subscription_status` events here.

- [ ] **Step 1: Failing tests** — ACTIVE twice → one activation message, next date per rule (incl. 20:30 activation case); FAILED while pending → `authorization_failed` + message;
  CUSTOMER_CANCELLED on active with one future `created` charge → `cancelled`, charge cancelled at provider, payment and upcoming order `cancelled`; webhook body
  says ACTIVE but re-fetch says INITIALIZED → nothing changes; signed route test dispatches to the service.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(subscriptions): mandate activation and status changes`

---

### Task 6: Charge job — create the upcoming order, raise the charge, send the "upcoming charge" message

**Files:**
- Create: `src/subscriptions/charges.ts` (`raiseDueCharges`), `src/ingress/jobs-routes.ts`, `scripts/run-jobs.ts` (+ `package.json` script `jobs:run`)
- Modify: `src/app.ts`
- Test: `tests/subscriptions/raise-charges.test.ts`, `tests/ingress/jobs-routes.test.ts`

**Interfaces:**
- Produces:
  - `raiseDueCharges(deps, tenant): Promise<{ raised: number; skipped: number }>` — algorithm in spec §10 "Charging". Per subscription:
    re-fetch Cashfree status (only `ACTIVE` proceeds; `CUSTOMER_PAUSED` → advance date, count skipped); build `charge_items` from
    `subscription_items` joined to **active** products at current prices; empty → advance date, skipped, warn; in one transaction
    create the order (`createOrder` with `status: 'payment_pending'`, `source: 'subscription'`, `subscriptionId`, delivery date D,
    address/location from the subscription) and the payment (`order_id` = that order; unique violation on (`subscription_id`,
    `for_delivery_date`) → already raised, roll back, skip silently); `raiseCharge`; on provider error delete that payment and
    order and leave the date unchanged (next hourly run retries); then advance `next_delivery_date` and send
    `templateMsg('subscription_upcoming_charge', 'en', [rupees, formatDeliveryDate(D)], { quickReplyPayloads: ['skip:<paymentId>'] })`.
    A template send failure is logged, not thrown.
  - `POST /jobs/subscription-charges` — header `x-jobs-secret` must equal `env.JOBS_SECRET` (missing env or mismatch → 401);
    runs `raiseDueCharges` for every registered tenant; returns `{ tenants, raised, skipped }`.
  - `pnpm jobs:run [--now <ISO>]` — runs the same once locally (dev testing; `--now` overrides the clock).

- [ ] **Step 1: Failing tests** (fixed clocks, Wed-delivery weekly subscription, D = 2026-11-25): on Sun 22 Nov nothing; on Mon 23 Nov 10:00
  IST one `payment_pending` subscription order for 2026-11-25 and one payment (`created`, `order_id` = that order, current prices, + delivery fee), `raiseCharge` scheduled 2026-11-24, next date
  2026-12-02, one upcoming template with the skip payload; same run again → nothing new; D = tomorrow → scheduled for D; D = today → skipped,
  no charge; biweekly advances 14, monthly 28 (incl. year rollover); product repriced → new price; product deactivated → line dropped; all
  dropped → skipped, no ₹0 charge and no order; Cashfree status CUSTOMER_PAUSED → skipped; raise fails → no payment or order left, date unchanged; the upcoming order is absent from `/admin/orders/active`; job route 401 without/with wrong secret.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(subscriptions): hourly charge job, upcoming order and message`

---

### Task 7: Skip button and charge results

**Files:**
- Create: `src/subscriptions/charge-results.ts` (`onChargeResult`, `skipCharge`)
- Modify: `src/bot/router.ts`, `src/ingress/cashfree-routes.ts`, `src/payments/cashfree/webhook.ts` (`SUBSCRIPTION_PAYMENT_CANCELLED`)
- Test: `tests/subscriptions/skip.test.ts`, `tests/subscriptions/charge-results.test.ts`

**Interfaces:**
- Produces:
  - Router: button `replyId` starting `skip:` → `skipCharge(deps, tenant, customer, paymentId)`: payment must belong to this customer's
    subscription (else menu). Decision by state (support phone from tenant settings):
    - payment `cancelled` → `copy.skipDone` again (no provider call);
    - payment `paid` / order `confirmed` (or later) → `copy.skipAlreadyPaid`, no provider call;
    - payment `created` or `failed` (UPI retries may be pending) → `cancelCharge` (a refusal is not an error), then re-fetch `getCharge`:
      `CANCELLED` → payment and its order `cancelled`, `copy.skipDone({ date, next })`;
      `SUCCESS` → apply `onChargeResult` (order confirmed, webhook may still be on its way) and reply `copy.skipAlreadyPaid`;
      `PENDING`/`INITIALIZED` with cancel refused → `copy.skipProcessing`, nothing changed (the webhook settles it);
      `FAILED` with cancel refused → payment and order `cancelled`, `copy.skipDone`.
  - `onChargeResult(deps, tenant, subscriptionId, paymentId): Promise<'confirmed' | 'failed' | 'cancelled' | 'unchanged'>` — payment found
    by `provider_ref = paymentId` (must belong to `subscriptionId`), its order via `payments.order_id`; re-fetch `getCharge`; `SUCCESS` and
    payment not `paid` → in one transaction payment `paid`, order `payment_pending` → `confirmed` with `paid_at` (conditional updates, so a
    repeat changes nothing); no customer message. `FAILED` and payment `created` → payment `failed`, order `payment_failed`, template
    `subscription_charge_failed [date]`. `CANCELLED` → payment and order `cancelled`. Anything else → `unchanged`. Cashfree route dispatches `subscription_charge` events here.

- [ ] **Step 1: Failing tests** — skip of own `created` charge → provider cancel, payment and order `cancelled`, skipDone text with next date; skip twice →
  one cancel call, same reply; skip when cancel is refused and re-fetch says SUCCESS → order `confirmed`, payment `paid`, already-paid text with the support
  number; skip on an already `confirmed` order → already-paid text, no provider call; cancel refused + PENDING → processing text, nothing changed;
  support phone unset → "reply Help" wording; skip on a `failed` charge → retries cancelled, order `cancelled`; another customer's payment id → menu;
  success webhook twice → order `confirmed` once (still exactly one order for the cycle), payment `paid`, no outbound message; failure →
  order `payment_failed`, one template, second failure webhook → none; success after a local `failed` → order `confirmed`; cancelled webhook →
  payment and order `cancelled`; unknown payment id → `unchanged`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(subscriptions): skip a delivery and confirm or fail the upcoming order`

---

### Task 8: Vendor cancel, My Orders, ops CLI

**Files:**
- Modify: `src/subscriptions/subscription-service.ts` (`cancelSubscription`), `src/bot/my-orders.ts`, `scripts/orders.ts`
- Test: `tests/subscriptions/cancel.test.ts`, `tests/bot/my-orders.test.ts`

**Interfaces:**
- Produces:
  - `cancelSubscription(deps, tenant, subscriptionId): Promise<'cancelled' | 'already_cancelled'>` — provider `cancelSubscription`
    (provider error → throw, nothing changed), then `cancelled`, `next_delivery_date` null, each future `created` charge cancelled
    with its upcoming order → `cancelled` (best effort, logged), customer gets `copy.subscriptionCancelled()`. `pending_authorization` subscriptions can be cancelled too.
  - My Orders lists active subscriptions with `frequencyLabel` and the next delivery date, and shows upcoming (`payment_pending`)
    subscription orders as "Upcoming · payment tomorrow" (one-time pending orders keep today's wording).
  - CLI: `pnpm orders <tenant> sub <subscriptionId> cancel`.

- [ ] **Step 1: Failing tests** — cancel active with a future charge → provider cancel + charge cancel, state, one message; twice → `already_cancelled`,
  no second call; provider error → state unchanged; My Orders shows "every 2 weeks on Wednesday (next: Wed, 2 Dec)" and an upcoming
  subscription order as "Upcoming · payment tomorrow".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(subscriptions): vendor cancel, my orders and cli`

---

### Task 9: Admin API — subscriptions list, detail, cancel; subscription info on orders

**Files:**
- Create: `src/admin/subscriptions/{queries,routes}.ts`
- Modify: `src/admin/app.ts`, `src/admin/orders/views.ts`, `src/admin/http.ts` (map new errors if any), `docs/admin-api.md`
- Test: `tests/admin/subscriptions.test.ts`, `tests/admin/orders-read.test.ts`

**Interfaces:**
- Produces (exact shapes written into `docs/admin-api.md` in this task):
  - `GET /admin/subscriptions?status=&page=&pageSize=` → paged `SubscriptionView[]`, newest first:
    `{ id, status, frequency, deliveryWeekday, nextDeliveryDate, perDeliveryTotalPaise, pincode, address, customer: { id, profileName, phone }, createdAt }`.
  - `GET /admin/subscriptions/:id` → `{ subscription: SubscriptionView & { items: { productId, name, quantity, unitPricePaise, active }[],
    charges: { id, forDeliveryDate, amountPaise, status, orderId, orderCode, createdAt }[] } }`.
  - `POST /admin/subscriptions/:id/cancel` → `200 { result: 'cancelled' | 'already_cancelled', subscription }`; 502 `provider_error` on Cashfree failure.
  - `OrderView` gains `subscriptionId: string | null`; `paymentStatus` uses the order's subscription-charge payment when there is no link payment.
  - `GET /admin/orders/active` keeps excluding `payment_pending`, so upcoming subscription orders show only on the Orders page (contract note added).
  - Customer detail (`GET /admin/customers/:id`) gains `subscriptions: SubscriptionView[]`.

- [ ] **Step 1: Failing tests** — list filters/pages/hides other tenants; detail shows items and charges with order codes; other tenant → 404; cancel
  calls the service once, 502 on provider error; subscription order in `/admin/orders` has `source: 'subscription'`, `subscriptionId`, `paymentStatus: 'paid'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + contract; copy contract to the dashboard repo. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(admin): subscriptions list, detail and cancel`

---

### Task 10: End-to-end on the test number, docs and deployment notes

**Files:**
- Modify: `docs/runbook.md`, `docs/user-guide.md`, `docs/client-onboarding.md`, `docs/session-handoff.md`, `docs/phase2-dashboard-brief.md`

**Interfaces:**
- Produces: docs only — Cashfree dashboard webhook (subscription events, 2026-01-01) for sandbox and production; Cloud Scheduler job
  `POST /jobs/subscription-charges` hourly 08:00–20:00 IST with `x-jobs-secret`; templates on the real number; Subscribe Flow publishing;
  user-guide pages for subscribing, skipping and cancelling; dashboard brief for the subscriptions screens.

- [ ] **Step 1: Live run (sandbox + test number, with the user)** — subscribe from WhatsApp via the draft Flow, approve the mandate on the sandbox
  checkout, see the activation message; `pnpm jobs:run --now <D-2 10:00 IST>` → upcoming order (payment pending) on the dashboard and the upcoming
  message with Skip; tap Skip on one cycle → skip reply, order cancelled, Cashfree shows the charge cancelled; let the next cycle collect → the
  order turns confirmed on the dashboard; cancel from the admin API.
- [ ] **Step 2: Fix anything found** (each fix gets a test).
- [ ] **Step 3: Docs** as listed; full suite, typecheck, build, secret check.
- [ ] **Step 4: Commit** `docs(subscriptions): runbook, user guide and onboarding`

---

### Task 11 (on hold — do last, only when the user asks): Refunds for subscription orders

**Files:**
- Modify: `src/payments/provider.ts`, `src/payments/cashfree/client.ts`, `src/orders/order-status.ts` (`refundOrder`), `tests/helpers/fakes.ts`, `docs/admin-api.md`
- Test: `tests/orders/refund.test.ts`, `tests/payments/cashfree-subscriptions.test.ts`

**Interfaces:**
- Produces: `refundCharge(t, subscriptionId, paymentId, amountPaise, refundId)` → `POST /pg/subscriptions/{id}/refunds`;
  `refundOrder` accepts `source: 'subscription'` orders, finds the order's subscription-charge payment, refunds it with
  `refundIdFor(orderId)` and follows the same "refund, then cancel if still open" rules as one-time orders. The dashboard's
  existing Refund button then works for subscription orders (used after a customer contacts help following "already paid").

- [ ] **Step 1: Failing tests** — paid subscription order refund → provider call with the charge's payment id, payment `refunded`, order `cancelled`;
  repeat → `already_refunded`; unpaid charge → `refund_not_possible`. **Step 2–4:** run/implement/run. **Step 5: Commit** `feat(subscriptions): refund subscription charges`

