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
5. **Subscribe** → Subscribe Flow: products/quantities per delivery, email, address → validate → subscription `pending_authorization` → send **Set up AutoPay** button (Cashfree auth link).
6. Mandate active → confirmation with first delivery date. Daily job raises a charge before each delivery; success ⇒ a `confirmed` order for that date; failure ⇒ `subscription_charge_failed` template, that week skipped.
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
6. Subscription self-service (pause/skip/cancel from WhatsApp), bi-weekly frequency.
7. Payment-link expiry reminder message.
8. Queue (Cloud Tasks/BullMQ) + per-customer ordering if traffic grows.
9. Live dashboard push (SSE) instead of polling.
10. Tech-provider registration + Embedded Signup for onboarding new tenants; encrypted per-tenant secrets in DB.
11. COD.
12. Close Supabase's public Data API: enable RLS (no policies) on every table, or turn the Data API off — **do before real customer data lands**. Our server connects as the owner and is unaffected.
13. Enforce one payment per order in the DB: partial unique index on `payments.order_id` (where not null). Logic already guarantees it; the index turns a future bug into a loud error instead of a silent duplicate.
14. Reconcile missed payment webhooks: a periodic job that re-checks one-time `payment_pending` orders older than the link expiry with Cashfree (PAID → confirm, else expire). Deferred 2026-11-14: expiry is handled from Cashfree's `PAYMENT_LINK_EVENT` EXPIRED webhook (verified live), and a customer who paid but still sees "Payment pending" in My Orders is told to tap Help.
15. Subscriptions (plan Tasks 13, the subscription-charge half of 14, and subscription cancel in 15) — on hold since 2026-11-14 at the user's request; the schema, copy and webhook parsing already support them.
16. Paid-after-close: when a payment lands on an already expired/cancelled order (`paid_after_close`), today only an error log ("refund needed") is written. Add a customer message ("we received your payment after the link expired — refund on its way") and an automatic or dashboard-driven refund.
