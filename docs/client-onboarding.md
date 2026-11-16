# Onboarding a New Client

How to add a new business ("tenant") to C2V: what to collect, what to configure, what code to add,
and how to verify. NutriFarm Eggs (`nutrifarm`) is the reference tenant; copy from it.
Deployment details live in `docs/runbook.md`.

Rough effort: about half a day of our work, plus waiting time for Meta (display name and template approvals)
and Cashfree (KYC / production activation).

---

## 1. Collect from the client

**Business**
- Business name as customers should see it, and a short tenant id (lowercase, e.g. `greenmilk`).
- Order code prefix, 2–3 letters (e.g. `GM` → `GM-7K3QX9`). Must differ from other tenants for clarity.
- Support phone (for the Help button), delivery fee, minimum order, welcome image URL (optional, public https).
- Products (max **8 active**: the order form has 8 slots): name, price, display order, SKU.
- Delivery areas: pincodes and each pincode's delivery weekday. A short "we deliver to …" sentence.
- Delivery partners: name and phone.
- Message wording and tone (welcome, menu descriptions, confirmations). English only today.

**Meta / WhatsApp** (the client owns these; we get access)
- A Meta business portfolio for the client, **business verification** done.
- A WhatsApp Business Account (WABA) and a **real phone number** not already used on WhatsApp.
- Display name submitted. Sending stays blocked until Meta approves it.
- Our Meta app **C2V** given access to the client's WABA (assign the app / a system user to the WABA), and a
  **permanent system-user access token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
- From these: the **phone_number_id** and **WABA id**.

**Cashfree** (the client's own account; money settles to the client)
- Cashfree Payment Gateway account with KYC complete, **Payment Links** enabled.
- **Sandbox** App ID + Secret Key for testing, and later **production** App ID + Secret Key.
- No dashboard webhook setup needed: each payment link carries our notify URL.

Secrets (tokens, Cashfree keys) must reach us securely and go only into `.env.*` and Secret Manager.
Never put them in chat, email threads or git.

---

## 2. Environment keys to add

Per tenant, using the tenant id in upper case as the prefix (example `GREENMILK`):

| Key | Value | Where |
|---|---|---|
| `GREENMILK_WA_TOKEN` | Client's system-user WhatsApp token | `.env.dev`, `.env.prod`, Secret Manager |
| `GREENMILK_CF_APP_ID` | Cashfree App ID (sandbox in dev, production in prod) | same |
| `GREENMILK_CF_SECRET` | Cashfree Secret Key | same |
| `GREENMILK_WA_PHONE_NUMBER_ID` *(optional)* | Only if you want an env override of the id in code (e.g. testing on another number) | `.env.*` |
| `GREENMILK_WABA_ID` *(optional)* | Same as above | `.env.*` |

Also add the names (no values) to `.env.example`.

**Shared keys don't change** for a new tenant: `META_APP_SECRET` and `META_VERIFY_TOKEN` (one Meta app, C2V,
for all tenants), `DATABASE_URL`, `PUBLIC_BASE_URL`, `CASHFREE_ENV`, `GRAPH_API_VERSION`.
Note: `CASHFREE_ENV` is global, so all tenants are on sandbox or all on production at the same time.

After adding secrets to Secret Manager, add them to the Cloud Run service's secret bindings
(`gcloud run services update c2v-bot --region asia-south1 --update-secrets GREENMILK_WA_TOKEN=GREENMILK_WA_TOKEN:latest,...`).
Use `--update-secrets` / `--update-env-vars`, **not** `--set-*`, which would wipe the existing bindings.

---

## 3. Code changes

1. **Tenant folder** `src/tenants/<id>/` (copy `src/tenants/nutrifarm/`):
   - `config.ts`: `id`, `name`, `waPhoneNumberId`, `wabaId` (with the optional `process.env.<ID>_WA_PHONE_NUMBER_ID || '<id>'`
     override pattern), `waTokenEnv: '<ID>_WA_TOKEN'`, `cashfree: { appIdEnv: '<ID>_CF_APP_ID', secretEnv: '<ID>_CF_SECRET' }`,
     `flows.orderFlowId` (filled in step 5.4; `subscribeFlowId: ''`), `orderCodePrefix`, `paymentLinkExpiryMinutes` (30),
     `subscriptionChargeLeadDays`, `messageRetentionDays`, `copy`.
   - `copy.ts`: every customer-facing message (the `TenantCopy` interface in `src/tenants/types.ts` lists them;
     TypeScript fails the build if one is missing). Include the delivery-areas sentence.
2. **Register the tenant** in `registerTenants([nutrifarm, <newTenant>])` in `src/index.ts`, and in the scripts
   that register tenants: `scripts/orders.ts`, `scripts/publish-flows.ts`, `scripts/checkout-check.ts`,
   `scripts/send-samples.ts`. The registry rejects duplicate tenant ids or phone_number_ids at startup.
3. **Seed data:** `scripts/seed.ts` is currently written for NutriFarm only. Add the new tenant's tenant row,
   products, pincodes and delivery partners (refactoring it into per-tenant seed data is a good first change).
   The seed only inserts and never overwrites rows the vendor edited.
4. **Copy tests:** add a copy test like `tests/tenant-copy.test.ts` for the new tenant.
5. **Known NutriFarm-specific strings in shared code. Fix these before onboarding a non-egg client:**
   - `src/bot/menu.ts`: menu row title `'Order Eggs'`.
   - `src/channels/whatsapp/flows.ts`: Flow screen title `'Choose your eggs'` (and the example label). The Flow
     JSON is published per WABA, so a per-tenant title needs the Flow builder to take the tenant's wording.
   - Recommended: move both into `TenantCopy` (e.g. `menuOrderTitle()`, `orderFlowTitle()`).
6. Run `pnpm test`, `pnpm typecheck`, `pnpm build`.

No changes are needed to the webhook endpoints, the order/payment logic, or the database schema. The
WhatsApp webhook finds the tenant by phone_number_id, and the Cashfree webhook finds it from the payment and
verifies the signature with that tenant's Cashfree secret.

---

## 4. Database

```bash
ENV=prod pnpm db:seed          # inserts the new tenant's rows (idempotent)
```
- Migrations are shared. Run `ENV=prod pnpm db:migrate` only if the schema changed.
- The nightly chat cleanup (`purge-old-messages`) already covers all tenants (3-day retention, global).
- RLS is already on for all tables. Nothing to do per tenant.

---

## 5. Meta setup (per tenant)

1. Phone number registered (Cloud API) and connected; display name approved (check with Graph API
   `GET /<phone_number_id>?fields=name_status,status,quality_rating`).
2. **Subscribe the client's WABA to app C2V** (`POST /<waba_id>/subscribed_apps` with the client's token).
   The app's webhook URL (`https://<run-url>/webhooks/whatsapp`) is set once for app C2V and shared by all
   tenants. Don't change it per tenant.
3. **Templates** on the client's WABA: `order_delivered`, Utility, language `en`, body
   "Your order {{1}} has been delivered. Thank you for ordering from <Business>! 🥚" (adjust wording/emoji).
   Wait for APPROVED. (`out_for_delivery_template` only if that feature is enabled later.)
4. **Order Flow:** `ENV=prod pnpm flows:publish <id> --name order_v1` → paste the printed flow id into
   `src/tenants/<id>/config.ts` → commit and redeploy. If Meta blocks publishing ("integrity requirements"),
   create it with `--draft` and publish later with `--flow-id <id>`.
5. While the number is unverified or testing: Meta only delivers to numbers on the app's recipient list.

---

## 6. Cashfree setup

- Sandbox first: put the sandbox keys in `.env.dev` and run `pnpm cashfree:check create` for the tenant (adjust the
  script's tenant if needed), then an end-to-end order with `checkout:test`.
- Go-live: production keys into `.env.prod` + Secret Manager, `CASHFREE_ENV=production` (global, see §2).
  Make sure the client's Cashfree production account has Payment Links and refunds enabled.

---

## 7. Deploy and verify

1. Deploy (runbook §7 redeploy: `gcloud run deploy c2v-bot --source . --region asia-south1`, keeps existing env/secrets).
2. Smoke test from a real phone on the client's number:
   Hi → menu · Order → form → Pay → pay → confirmation (+ location request) · My Orders ·
   `ENV=prod pnpm orders <id> <code> assign <partnerPhone>` → `out-for-delivery` → `delivered` (template arrives) ·
   refund a test order.
3. Check logs: `gcloud run services logs read c2v-bot --region asia-south1`. There should be no unknown-tenant or
   signature-failure warnings for the new number.
4. **Create the vendor login** and hand it over: `ENV=prod pnpm vendors create <id> <username>` prints a generated
   password once; give it to the client securely (they can change it in the dashboard). Reset later with
   `pnpm vendors reset-password <username>`.
5. In the dashboard, add the delivery partners and **generate each partner's private link** (copy or share it on
   WhatsApp). A partner added before migration `0004` needs one "reset link" first.

---

## 8. Checklist

- [ ] Client info collected (§1)
- [ ] Env keys in `.env.dev`, `.env.prod`, Secret Manager, Cloud Run bindings (§2)
- [ ] Tenant folder, registration, seed, copy test (§3); build and tests pass
- [ ] Shared egg-specific strings made per-tenant (if the client isn't an egg seller)
- [ ] Seed run on prod (§4)
- [ ] Number live + display name approved, WABA subscribed to C2V, `order_delivered` approved, Flow published (§5)
- [ ] Cashfree sandbox tested, then production keys (§6)
- [ ] Deployed + smoke test passed (§7)
- [ ] Vendor login created and handed over; partner links generated (§7)

## 9. Future improvements that make this easier

- One shared tenant list module so scripts don't each register tenants (`src/tenants/all.ts`).
- Per-tenant seed files.
- Tenant wording for menu and Flow titles via `TenantCopy`.
- Backlog #10: Meta Tech Provider + Embedded Signup and encrypted per-tenant secrets in the DB, so onboarding
  needs no code change or redeploy.
- Per-tenant `CASHFREE_ENV` and per-tenant message retention.
