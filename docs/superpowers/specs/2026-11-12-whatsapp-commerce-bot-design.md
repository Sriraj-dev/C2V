# C2V WhatsApp Commerce Bot — Design (Phase 1: bot server)

Date: 2026-11-12 · First tenant: **NutriFarm Eggs** (Meta business portfolio `organic_nutri_farm`, Meta app "C2V")

## 1. Goal

A multi-tenant WhatsApp bot server that takes one-time orders and weekly subscriptions for a
small D2C business, collects payment through Cashfree, and persists customers, orders,
payments, subscriptions and chat messages so a later web dashboard (Phase 2) can operate on
them. Phase 1 = bare minimum that is testable end to end; everything else goes to the
Improvements list (§9).

## 2. Decisions (locked during discussion)

| Topic | Decision |
|---|---|
| Runtime | Node 22, TypeScript (strict), Hono, pnpm |
| Database | PostgreSQL on **Supabase free tier**, used as plain Postgres only (no Supabase Auth/SDK). Drizzle ORM. Connect via the Supabase transaction pooler. |
| Redis / queue | **None** in Phase 1. Webhooks are processed inside the request; duplicates are dropped via a unique WhatsApp message id. |
| Hosting | GCP Cloud Run (asia-south1), scale-to-zero; Cloud Scheduler hits a daily job endpoint. |
| Tenancy | One deployment serves all tenants. Constant tenant config (phone number id, WABA id, flow ids, env-var names, order code prefix, expiry/lead/retention values, copy) lives **in code** and is registered by `phone_number_id`. The `tenants` table holds only vendor-editable values (support phone, delivery fee, min order). Every business table carries `tenant_id` (text, e.g. `nutrifarm`). |
| Order identifiers | `orders.id` uuid internally; customer-facing `order_code` like `NF-7K3QX9` (random, unique per tenant). No counters. |
| Location | Optional: after an order is confirmed, customers without a saved pin get a "Send location" request; lat/lng saved on the customer and copied to open orders/subscriptions for the delivery partner's map link. |
| Customer identity | Keyed on business-scoped user id (`user_id`) when present, else `wa_id`. Both stored. |
| Ordering UI | WhatsApp **Flows without a data endpoint** (no catalog). Order summary + Pay button arrive as a chat message after Flow submit. |
| Payments | Cashfree. One-time: **Payment Link** API, sent as an interactive CTA-URL button, expiry **30 min**. Status confirmed via Cashfree webhook **and** a server-side GET before marking paid. |
| Subscriptions | Cashfree **Subscriptions (UPI AutoPay mandate)**, `ON_DEMAND` plan, **charged per delivery**. Authorisation link sent as a CTA-URL button. Customer email is mandatory (Cashfree requirement). `frequency` column supports weekly/biweekly/monthly (7/14/28 days, always on the pincode weekday); Phase 1 offers **weekly** only. The daily job records the charge and advances `next_delivery_date` when it **raises** the charge; the order is created only when the charge **succeeds**; a failed week is skipped. |
| Delivery date | Each serviceable pincode has one delivery weekday. Expected date = the **next** occurrence of that weekday, strictly after today (ordering on the delivery weekday ⇒ next week). Timezone Asia/Kolkata. |
| Fees | Delivery fee 0, no minimum order — both tenant config values. |
| Order statuses | `payment_pending → confirmed → assigned → out_for_delivery → delivered`, plus `cancelled`, `payment_failed`, `expired`. Only `confirmed` onward are "real" orders for the dashboard. |
| Customer notifications outside 24h window | Utility templates: `order_delivered`, `subscription_charge_failed`. |
| Vendor alerts | None. |
| Chat history | Every inbound/outbound message stored in Postgres; per-tenant `message_retention_days` (default 3) enforced by the daily job. No read/delivered ticks. |
| Dashboard / APIs / login | Out of Phase 1. Status changes (assign, out-for-delivery, delivered, cancel, refund) exist as **services + a CLI script**; Phase 2 wraps them in HTTP. |
| Refunds / cancellations | Manual vendor decision; a `refundOrder` service calls Cashfree refund API. No automation. |
| Language | English only. |

## 3. User flow (bot)

1. Any message from a customer with no special meaning → **welcome/menu** (Order Eggs · Subscribe · My Orders; Help).
2. **Order Eggs** → Order Flow: screen `PRODUCTS` (one quantity dropdown 0–10 per active product, labels carry live price), screen `ADDRESS` (name, address line, landmark, pincode; pre-filled from last order).
3. On submit: validate (≥1 item, pincode 6 digits & serviceable). Not serviceable → "We don't deliver to <pincode> yet." Otherwise create order `payment_pending`, create Cashfree payment link, send summary (items, total, expected delivery date) with **Pay ₹X** button.
4. Cashfree reports paid → order `confirmed` → "Order NF-1042 confirmed, arriving Wed 18 Nov". (The link itself lets the customer retry failed attempts until expiry.)
5. **Subscribe** → Subscribe Flow: products/quantities per delivery, how often (weekly / every 2 weeks / every 4 weeks), email, address → validate → subscription `pending_authorization` → send **Set up AutoPay** button (our authorisation page, which opens Cashfree's mandate checkout). Details: §10.
6. Mandate active → confirmation with first delivery date. Two days before each delivery (D-2) a `payment_pending` subscription order is created, the charge is raised for collection on D-1, and the customer gets an "upcoming charge" template with a **Skip this delivery** button; skip ⇒ order `cancelled`; collected ⇒ order `confirmed`; failure ⇒ order `payment_failed` + `subscription_charge_failed` template. Details: §10.
7. **My Orders** → last 5 orders + active subscriptions.
8. **Help** → vendor phone as a call button.
9. Order marked delivered → `order_delivered` template.

## 4. Admin flow (Phase 2 dashboard — data must support it)

Orders (filter by date/status/pincode, assign partner, status changes, refund), today's
deliveries (one-time + subscription), subscriptions, pincodes (add/remove, weekday),
products, delivery partners, customers, chats (thread + reply within 24h window), payments.
Single vendor login created manually. Delivery partners have no login; they filter by
assignment.

**Needs refund list** (added 2026-11-14): payments marked `paid` whose order is `expired`/`cancelled`
(late payment after the link closed; the server logs "refund needed"). Show order code, customer,
amount and paid time, with a Refund button that calls Task 15's `refundOrder`. No email alert for now.

## 5. Architecture

Feature-oriented modules behind small ports so tenants and providers are swappable:

- `ingress/` — HTTP routes (WhatsApp webhook, Cashfree webhook, jobs). Verify, parse, delegate.
- `channels/whatsapp/` — webhook parsing → `InboundMessage`; `WhatsAppSender` port + Graph adapter; message builders; Flow JSON builders.
- `bot/` — stateless router: inbound message → handler (menu, order flow submit, subscribe flow submit, my orders, help).
- `orders/`, `payments/`, `subscriptions/`, `customers/`, `messages/`, `catalog/` — domain services + repos.
- `payments/` — `PaymentProvider` port; `cashfree/` adapter.
- `tenants/` — tenant row (DB) + per-tenant copy module (message texts).
- `jobs/` — daily job.

No conversation state machine is needed: buttons carry ids, Flows return complete data, and the
flow token says which Flow it was.

## 6. Data model (Postgres)

`tenants` (vendor-editable settings only), `customers` (+ `default_location`), `products`,
`pincodes`, `orders` (`order_code`, + `location`), `order_items`, `payments` (`order_id`
nullable; `subscription_id` + `for_delivery_date` unique; `charge_items` snapshot),
`subscriptions` (`frequency`, `cf_subscription_id`), `subscription_items`,
`delivery_partners`, `messages`. Money is integer paise. Address/location are snapshotted onto
each order and subscription. The order Flow uses 8 fixed product slots shown/hidden via data, so
the published Flow never changes when products change.

## 7. Capacity (Supabase free: 500 MB DB, 5 GB egress, shared CPU/500 MB RAM)

Chats at 3-day retention ≈ 2 MB; orders ≈ 20–40 MB/year. Daily job touches the DB so the 7-day
inactivity pause never triggers, and logs a warning when DB size > 400 MB. Phase 2 dashboard
must fetch incrementally (egress).

## 8. Out of scope for Phase 1

Dashboard, HTTP admin APIs, login, vendor alerts, COD, automated refunds, queues, Redis,
delivery/read ticks, multi-language, catalog, Flow data endpoint.

## 9. Improvements backlog (priority order)

1. Human takeover switch (pause bot per customer) — high.
2. Nightly `pg_dump` backup to Cloud Storage — high.
3. Enhanced Payment Links (native pay card): utility template + Meta allowlisting for Cashfree — no backend change.
4. Message delivery/read ticks (store `statuses` webhooks).
5. Admin filters: per-pincode delivery fee / min order, order cutoff time, store pause/holiday mode, daily capacity per pincode, waitlist for unserviceable pincodes.
6. Subscription self-service from WhatsApp: pause and cancel (skipping one cycle and the 2- and 4-week frequencies ship with §10).
7. Payment-link expiry reminder message.
8. Queue (Cloud Tasks/BullMQ) + per-customer ordering if traffic grows.
9. Live dashboard push (SSE) instead of polling.
10. Tech-provider registration + Embedded Signup for onboarding new tenants; encrypted per-tenant secrets in DB.
11. COD.
12. Close Supabase's public Data API: enable RLS (no policies) on every table, or turn the Data API off — **do before real customer data lands**. Our server connects as the owner and is unaffected.
13. Enforce one payment per order in the DB: partial unique index on `payments.order_id` (where not null). Logic already guarantees it; the index turns a future bug into a loud error instead of a silent duplicate.
14. Reconcile missed payment webhooks: a periodic job that re-checks one-time `payment_pending` orders older than the link expiry with Cashfree (PAID → confirm, else expire). Deferred 2026-11-14: expiry is handled from Cashfree's `PAYMENT_LINK_EVENT` EXPIRED webhook (verified live), and a customer who paid but still sees "Payment pending" in My Orders is told to tap Help.
15. Subscriptions — resumed 2026-11-18 on `feat/subscriptions`; design in §10, plan `docs/superpowers/plans/2026-11-18-subscriptions.md`.
16. Paid-after-close: when a payment lands on an already expired/cancelled order (`paid_after_close`), today only an error log ("refund needed") is written. Add a customer message ("we received your payment after the link expired — refund on its way") and an automatic or dashboard-driven refund.
17. Out-for-delivery notification: when an order is marked `out_for_delivery`, send the already-approved utility template `out_for_delivery_template` (en_US, body "Your order {{1}} is out for delivery and is expected to arrive by {{2}}." — {{1}} order code, {{2}} delivery date, e.g. "Wed, 18 Nov"). Deferred 2026-11-14 at the user's request; today out-for-delivery sends nothing.
18. Admin/partner API hardening (deferred 2026-11-15 with the admin API): rate limiting on login, `/admin/*` and `/partner/*`; an audit trail (who changed an order, product or setting, and when).
19. Staff logins: several vendor users per tenant with roles (the `vendor_users` table already allows several; the `pnpm vendors` CLI and dashboard assume one).
20. Deactivating a delivery partner does not unassign their open orders; the vendor must reassign them (the partner list shows `openOrderCount`). Consider blocking deactivation or auto-unassigning.
21. `order_confirmed` utility template sent when a subscription charge succeeds and its order is created (today subscription orders send nothing). Decided 2026-11-18.

## 10. Subscriptions (decisions 2026-11-18; supersedes earlier subscription lines)

Resumes backlog #15 on branch `feat/subscriptions`.

| Area | Decision |
|---|---|
| Frequencies | Customer picks **weekly** (7 days), **every 2 weeks** (14) or **every 4 weeks** (28, labelled "monthly"). Every delivery falls on the pincode's delivery weekday. |
| Mandate | Cashfree Subscriptions, **ON_DEMAND** plan (we raise each charge ourselves, so one cycle can be skipped by cancelling its charge, amounts follow current prices, and dates follow our frequency/weekday rule; PERIODIC would auto-debit a fixed amount on Cashfree's schedule), UPI AutoPay, mandate max = **2 × per-delivery total** (price headroom). Same PG API keys, API version `2026-01-01`. Customer email is mandatory. |
| Authorisation link | Cashfree returns a `subscription_session_id`, not a hosted URL, so the bot hosts `GET /subscribe/:token`, a tiny page that opens Cashfree's checkout (`cashfree.js` `subscriptionsCheckout`). The **Set up AutoPay** CTA points there. |
| Webhooks | Cashfree sends subscription events only to the **dashboard-configured** webhook (`<PUBLIC_BASE_URL>/webhooks/cashfree`, version 2026-01-01, subscription events only). Configured in sandbox 2026-11-18; production at go-live. The handler re-fetches state from Cashfree and never trusts the payload alone. |
| First delivery | First occurrence of the pincode weekday that is at least 2 days after activation (IST); if that date is exactly 2 days away and activation is at or after 20:00 IST, use the following one (charge must be raised before 21:00 on D-2). |
| Charging (Option A, decided 2026-11-18) | A job runs hourly 08:00–20:00 IST. For each `active` subscription with `next_delivery_date` (D) ≤ today + 2 (`subscriptionChargeLeadDays` = 2): create the **order** first (`payment_pending`, `source: subscription`, `subscription_id`, delivery date D, items at **current** prices + delivery fee, address/location from the subscription), then a `payments` row (`subscription_charge`, `created`, `order_id` = that order, `for_delivery_date` D, `charge_items`, `provider_ref` = the payment's own id), raise the Cashfree charge scheduled for **D-1**, advance `next_delivery_date` by the frequency step, then send the **upcoming charge** template. If D-1 is already today or earlier, schedule for D (still T+1). If D is today or past, the cycle is skipped and only logged. Unique (`subscription_id`, `for_delivery_date`) makes runs idempotent. The vendor sees the upcoming order from D-2 (Orders page, payment pending); it joins active orders once confirmed on D-1. |
| Upcoming charge message | Utility template `subscription_upcoming_charge`: "Your egg subscription: ₹{{1}} will be collected tomorrow for your delivery on {{2}}. Won't be available? Tap Skip this delivery below — we won't charge or deliver this time." One quick-reply button **Skip this delivery** (payload `skip:<paymentId>`). |
| Skip | Tap → if that charge is still `created` and not yet collected, cancel it at Cashfree (Manage Payment `CANCEL`), payment → `cancelled` and its order → `cancelled`, reply "Done. We won't charge or deliver on {date}. Your next delivery is on {next}." Already skipped → same reply. Decided by Cashfree's cancel result + re-fetch, not only our DB (the success webhook can lag). Already collected → order `confirmed` (if not already) and "This delivery is already paid and confirmed (order {code}). To cancel it, please contact us on {support phone}." Bank still processing → "Your payment for this delivery is already being processed. To cancel it, please contact us on {support phone}." (no support phone set → "reply Help"). The vendor refunds from the dashboard if needed. Default (no tap) = charge goes ahead. |
| Charge result | The webhook's `payment_id` is our `payments.id` → `payments.order_id` → the order. Success (re-fetched from Cashfree) → payment `paid`, order `payment_pending` → `confirmed` (`paid_at` set), **no customer message** (backlog: `order_confirmed` template). Final failure (after Cashfree's UPI retries) → payment `failed`, order `payment_failed`, template `subscription_charge_failed` ("We couldn't collect payment for your egg delivery on {{1}}. This week's delivery is skipped. Your subscription stays active."), subscription stays active. |
| Mandate changes | Cashfree `ACTIVE` → local `active`. `CUSTOMER_PAUSED` → no charges raised while paused (checked before raising). `CUSTOMER_CANCELLED` / `CANCELLED` / `EXPIRED` / `CARD_EXPIRED` → local `cancelled`, `next_delivery_date` null, future `created` charges cancelled (their orders → `cancelled`). Auth `FAILED` / `LINK_EXPIRED` while pending → `authorization_failed`. |
| Cancel | Vendor only, from the dashboard (customer self-service stays backlog #6): Cashfree `CANCEL`, local `cancelled`, any not-yet-collected charge cancelled and its upcoming order → `cancelled`. Confirmed orders are untouched. |
| Rules | Same minimum order and serviceable-pincode checks as one-time orders. Upcoming (`payment_pending`) subscription orders are excluded from `GET /admin/orders/active`; My Orders shows them as "Upcoming · payment tomorrow". No job expires them (link expiry applies only to one-time orders). |
| Dashboard API | `GET /admin/subscriptions` (paged, status filter), `GET /admin/subscriptions/:id` (items at current prices, charges with order codes), `POST /admin/subscriptions/:id/cancel`. Subscription orders appear in the existing order endpoints; `OrderView` gains `subscriptionId`, and `paymentStatus` covers subscription charges. |
| Refunds | Refunding a subscription charge (`POST /pg/subscriptions/{id}/refunds`) via the existing Refund button — planned as the last task, on hold until the user asks; until then `refundOrder` returns `not_supported` for subscription orders. |
