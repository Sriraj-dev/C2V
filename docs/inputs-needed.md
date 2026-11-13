# Inputs needed from you (by task)

Put every **secret** in a local `.env` file in the repo root (git-ignored). Never paste secrets in chat.
Non-secret answers (confirmations, texts, phone numbers) can just be told to me.

---

## Task 1 — Project scaffold
Nothing needed. ✅

## Task 2 — Database, migrations, seed
- [x] Supabase project + `DATABASE_URL` (transaction pooler, port 6543) — in `.env`, connection verified.
- [x] Supabase project moved to Mumbai (`ap-south-1`) — new `DATABASE_URL` in `.env`, ~21 ms per query.
- [x] Seed data (constants in `scripts/seed.ts`, not env vars):
  - Support phone `918310901383`
  - Products: White Eggs – 6 pack ₹90, 12 pack ₹168, 30 pack ₹390 (₹15/₹14/₹13 per egg)
  - Dev pincodes: 560034 Koramangala, 560102 HSR Layout, 560076 BTM Layout (Wed); 560068 Bommanahalli, 560037 Marathahalli (Sat)
  - Delivery partner: Ravi `919398651343`

## Task 3 — Money, pincode, delivery date, order code
Nothing needed. ✅

## Task 4 — WhatsApp webhook intake + tenant config
- [x] Bot number `+1 555-749-4425` (Meta test number) — Phone Number ID `1414838555047142`, WABA `2294321858083581` (verified via Graph API).
- [x] `META_APP_SECRET`, `META_VERIFY_TOKEN` — in `.env`.
- [ ] Tell me when the real number replaces the test number (only the config IDs change).

## Task 6 — Sending messages + message texts
- [x] `NUTRIFARM_WA_TOKEN` — in `.env`, verified.
- [x] Test phone `918074821478`.
- [ ] While on the test number: add every phone that will chat with the bot (yours, your friend's; max 5) to the **recipient list** at App Dashboard → C2V → WhatsApp → API Setup → "To". Otherwise replies fail with error 131030.

## Task 8 — Order Flow
- [x] Delivery areas text: "We deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli."

## Task 10 — Cashfree adapter
- [ ] Cashfree **sandbox** keys in `.env`: `NUTRIFARM_CF_APP_ID`, `NUTRIFARM_CF_SECRET`; `CASHFREE_ENV=sandbox`.

## Task 11 — Checkout end to end
- [x] ngrok installed.
- [ ] Access to the Cashfree sandbox dashboard to set the webhook URL (I'll give the exact URL).

## Task 13 — Subscriptions (UPI AutoPay)
- [ ] Subscriptions enabled on the Cashfree **sandbox**.
- [ ] Request Cashfree to enable **UPI AutoPay on production** (not self-serve; can take days).
- [ ] A test email address for subscription sign-up.

## Task 14 — Daily job
- [x] `JOBS_SECRET` — generated into `.env`.

## Task 16 — Deployment (production)
- [ ] **GCP project** with billing; `gcloud` installed and logged in.
- [ ] Production `DATABASE_URL` (Mumbai).
- [ ] Cashfree **production** keys (KYC done), `CASHFREE_ENV=production`, UPI AutoPay enabled.
- [ ] Meta app **C2V** in **Live** mode + payment method on the WhatsApp account.
- [ ] Approve wording of the `order_delivered` and `subscription_charge_failed` templates (I'll draft).
- [ ] Real prices / pincodes / support number from the vendor (editable in DB later).

---

### `.env` keys
```
DATABASE_URL=          ✅ (Mumbai)
META_APP_SECRET=       ✅
META_VERIFY_TOKEN=     ✅
NUTRIFARM_WA_TOKEN=    ✅
JOBS_SECRET=           ✅
GRAPH_API_VERSION=     # I'll set this
PUBLIC_BASE_URL=       # I'll set this from ngrok / Cloud Run
CASHFREE_ENV=sandbox
NUTRIFARM_CF_APP_ID=
NUTRIFARM_CF_SECRET=
```
