# C2V bot runbook: deploying and operating a tenant

Written for the developer. Commands run from the repo root. GCP-specific values are marked `<PROJECT_ID>`.
Subscriptions are not enabled; nothing here sets them up.

## 1. Prerequisites

- gcloud CLI, logged in (`gcloud auth login`) with access to the GCP project `<PROJECT_ID>`.
- Docker Desktop (only for local image checks; Cloud Run builds from source remotely).
- Node 22 and pnpm (`pnpm install`).
- Supabase access (project dashboard and the `postgres` connection string).
- Meta developer access to the app "C2V" and the tenant's WhatsApp Business Account.
- Cashfree merchant dashboard access (sandbox and production).

## 2. Environments

- `.env.dev` is the default; `.env.prod` holds production values. Both are git-ignored. `.env.example` lists every variable.
- Every pnpm script loads `.env.${ENV:-dev}`. Prefix with `ENV=prod` to use production values, for example `ENV=prod pnpm orders ...`.
- Data-changing scripts print `Environment: <name> (.env.<name>)` first; a prod run prints a warning line. Check it before you continue.
- Cloud Run does not read files. It gets secrets from Secret Manager and non-secret values from `--set-env-vars`.
- `NODE_ENV` is set to `production` by the Dockerfile. `PORT` is set by Cloud Run (8080).

## 3. Database

Currently one Supabase project serves both prod and dev, so `DATABASE_URL` in `.env.dev` and `.env.prod` point to the same database. Treat every migration as a production change.

1. Apply migrations from your laptop: `ENV=prod pnpm db:migrate`. The container never runs migrations.
2. Seed the tenant: `ENV=prod pnpm db:seed`. It only inserts rows that do not exist; it never overwrites vendor edits.
   Note on migration `0004` (vendor logins, sessions and partner link tokens) was **already applied to the shared Supabase DB on 2026-11-15**; re-running `db:migrate` is a no-op. Partners created before `0004` have no private link: in the dashboard (or `POST /admin/partners/:id/reset-link`) use "reset link" once per partner to generate it.
3. Schedule the nightly message purge (once per database): `ENV=prod pnpm db:schedule-cleanup` (append `--days N` to change the default of 3). Run it with the `postgres` role connection string. It replaces the existing `purge-old-messages` job, so re-running is safe.
4. Vendor logins for the dashboard (the admin API, `/admin/*`): create one per tenant with `ENV=prod pnpm vendors create <tenantId> <username>`; it prints a generated password **once**, so hand it over securely (not by chat or email threads that are kept). `ENV=prod pnpm vendors reset-password <username>` issues a new password and ends all sessions; `deactivate <username>` blocks login and ends sessions; `activate <username>` re-enables it. The `nutrifarm` tenant's login was created on 2026-11-15. Sessions last 30 days.
5. RLS: every table has row level security enabled with no policies, so Supabase's public Data API (anon/authenticated roles) can read nothing. The server connects as `postgres`, which bypasses RLS. A test fails if a new table forgets `.enableRLS()` in `src/db/schema.ts`.

## 4. Cloud Run

All commands assume `gcloud config set project <PROJECT_ID>`.

1. Enable APIs (once):
   ```
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
   ```
2. Create one secret per sensitive value from `.env.prod`. Pipe the value in so it never lands in shell history or a file:
   ```
   printf '%s' "$VALUE" | gcloud secrets create DATABASE_URL --data-file=-
   ```
   `DATABASE_URL` must use the `postgres` role (pooler username `postgres.<project-ref>`), not a restricted role: RLS is enabled with no policies, so only a role that owns the tables or has BYPASSRLS can read them.
   Secrets: `DATABASE_URL`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `NUTRIFARM_WA_TOKEN`, `NUTRIFARM_CF_APP_ID`, `NUTRIFARM_CF_SECRET`. To update later, use `gcloud secrets versions add NAME --data-file=-`.
3. Let the Cloud Run runtime service account read them (default compute service account unless you set another). Least privilege is a binding per secret (`gcloud secrets add-iam-policy-binding NAME --member=... --role=roles/secretmanager.secretAccessor`); the project-wide binding below is simpler:
   ```
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   ```
4. First deploy only (Cloud Build uses the repo `Dockerfile`):
   ```
   gcloud run deploy c2v-bot --source . --region asia-south1 \
     --allow-unauthenticated --min-instances 0 --max-instances 2 \
     --set-secrets DATABASE_URL=DATABASE_URL:latest,META_APP_SECRET=META_APP_SECRET:latest,META_VERIFY_TOKEN=META_VERIFY_TOKEN:latest,NUTRIFARM_WA_TOKEN=NUTRIFARM_WA_TOKEN:latest,NUTRIFARM_CF_APP_ID=NUTRIFARM_CF_APP_ID:latest,NUTRIFARM_CF_SECRET=NUTRIFARM_CF_SECRET:latest \
     --set-env-vars GRAPH_API_VERSION=v23.0,CASHFREE_ENV=sandbox,LOG_LEVEL=info,PUBLIC_BASE_URL=https://placeholder.invalid
   ```
   `--allow-unauthenticated` is required: Meta and Cashfree call the webhooks without Google credentials. Both webhooks verify signatures themselves.
   The app refuses to start if a required variable is missing; check the logs if the deploy fails its startup probe.
5. Note the service URL printed at the end, then verify: `curl https://<run-url>/health` returns `{"ok":true}`.
6. Set the real public URL and redeploy the revision:
   ```
   gcloud run services update c2v-bot --region asia-south1 --update-env-vars PUBLIC_BASE_URL=https://<run-url>
   ```
7. Later deploys: `gcloud run deploy c2v-bot --source . --region asia-south1`. Do NOT repeat the step 4 flags: `--set-env-vars` replaces the whole env set (it would reset `CASHFREE_ENV` to sandbox and `PUBLIC_BASE_URL` to the placeholder). Existing secrets and env vars are kept. To change a single value use `--update-env-vars NAME=value` or `--update-secrets`.
8. Instances scale to zero and receive SIGTERM when stopped; the server drains and exits (logs `shutting down`).

## 5. Meta (WhatsApp)

1. Register the tenant's real WhatsApp number in the WABA (Meta Business / WhatsApp Manager) and create a system-user token with `whatsapp_business_messaging` and `whatsapp_business_management`. Store it as `NUTRIFARM_WA_TOKEN`. If the number's IDs differ from `src/tenants/nutrifarm/config.ts`, set `NUTRIFARM_WA_PHONE_NUMBER_ID` and `NUTRIFARM_WABA_ID` (or update the config).
2. In the Meta app "C2V" (developers.facebook.com), WhatsApp > Configuration: callback URL `https://<run-url>/webhooks/whatsapp`, verify token = the `META_VERIFY_TOKEN` secret. Subscribe the `messages` field. Meta calls `GET /webhooks/whatsapp` to verify, so the service must already be deployed.
3. Subscribe the app to the tenant's WABA (WhatsApp Business Tools / Graph `POST /<WABA_ID>/subscribed_apps` with the C2V app).
4. Note: the OMS number lives in a separate Meta app, so changing the C2V webhook does not affect it.
5. Publish the order Flow. Create/upload the draft first if you do not have one, then:
   ```
   ENV=prod pnpm flows:publish nutrifarm --flow-id <id>
   ```
   Without `--flow-id` it creates and publishes a new flow named `order_v1` (`--name` to change). Re-run only when the Flow layout changes. The flow id lives in code: paste the id it prints into `flows.orderFlowId` in `src/tenants/nutrifarm/config.ts` (currently the draft `1140197861942511`), then redeploy (step 7 of section 4). The Flow is not live until that redeploy.
6. Message template `order_delivered`, language `en`, one body parameter (the order code, e.g. "Your order {{1}} has been delivered."). Create it in WhatsApp Manager (or via the WhatsApp Business MCP) and wait for approval. Without it, marking an order delivered still succeeds but the customer is not notified.

## 6. Cashfree

1. Start with sandbox: `CASHFREE_ENV=sandbox` and sandbox app id/secret. Run the smoke test (section 7) end to end.
2. Go live: put production app id/secret into the `NUTRIFARM_CF_APP_ID` / `NUTRIFARM_CF_SECRET` secrets (add new versions), then `gcloud run services update c2v-bot --region asia-south1 --update-env-vars CASHFREE_ENV=production`.
3. Webhooks: each payment link is created with `notify_url = <PUBLIC_BASE_URL>/webhooks/cashfree` (see `src/payments/cashfree/client.ts` and `src/orders/checkout.ts`), so no dashboard webhook is needed for payment links. That is why `PUBLIC_BASE_URL` must be the real service URL before taking payments. Webhooks are verified with the tenant's `NUTRIFARM_CF_SECRET`. If you later add a dashboard-level webhook, point it at the same URL.
4. Whitelist the Cloud Run egress IP in Cashfree only if the account has IP restrictions enabled (Cloud Run egress IPs are not fixed by default).

## 7. Smoke test

Do this after the first deploy and after switching to production keys. Use a real phone.

1. Send "Hi": the menu appears.
2. Tap Order Eggs: the Flow opens; submit an order; a Pay button arrives.
3. Pay (sandbox test UPI/card first): a confirmation message and a location request arrive; the order is `paid` in the DB.
4. Open My Orders: the order is listed.
5. Assign and deliver:
   ```
   ENV=prod pnpm orders nutrifarm <ORDER_CODE> assign <partnerPhone>
   ENV=prod pnpm orders nutrifarm <ORDER_CODE> out-for-delivery
   ENV=prod pnpm orders nutrifarm <ORDER_CODE> delivered
   ```
   The customer receives the `order_delivered` template.
6. Refund a test order: `ENV=prod pnpm orders nutrifarm <ORDER_CODE> refund`.

## 8. Operations

- Order CLI: `pnpm orders <tenantId> <orderCode> assign <partnerPhone> | out-for-delivery | delivered | cancel | refund`. Use `ENV=prod` for the live system. Status changes are race-safe; invalid transitions are rejected.
- Refunds: `refund` refunds a paid one-time order in full via Cashfree and also cancels the order (confirmed / assigned / out-for-delivery). It is idempotent (fixed refund id per order): re-running returns "already refunded", and if the provider refunded but the DB update failed, re-run it. `cancel` alone never touches payments, so a cancelled order that was paid still "needs refund": run `refund` on it. Subscription-order refunds are not supported.
- Logs: `gcloud run services logs read c2v-bot --region asia-south1 --limit 100` (add `--log-filter` or use Cloud Console Logs Explorer). Logs are JSON (pino); `LOG_LEVEL` controls verbosity.
- Rolling back: Cloud Console > Cloud Run > c2v-bot > Revisions, or `gcloud run services update-traffic c2v-bot --region asia-south1 --to-revisions <REVISION>=100`.
- Rotating a secret: `gcloud secrets versions add NAME --data-file=-`, then redeploy or `gcloud run services update c2v-bot --region asia-south1` to pick up `latest`.
- Connectivity checks from your laptop: `pnpm cashfree:check`, `pnpm samples:send`, `pnpm checkout:test` (dev tools; they send real messages and create real links for the env they load).

## 9. Adding the next tenant

1. Create `src/tenants/<id>/config.ts` (copy `src/tenants/nutrifarm/config.ts`): id, WhatsApp phone number id and WABA id, `waTokenEnv` and `cashfree.appIdEnv` / `secretEnv` names, order code prefix, copy.
2. Register it in `registerTenants([...])` in `src/index.ts` and in the scripts that call it (`scripts/orders.ts`, `publish-flows.ts`, `checkout-check.ts`, `send-samples.ts`).
3. Add the new env vars (`<ID>_WA_TOKEN`, `<ID>_CF_APP_ID`, `<ID>_CF_SECRET`) to `.env.example`, `.env.prod`, Secret Manager, and `--set-secrets`.
4. Seed the tenant row, products and pincodes (extend or copy `scripts/seed.ts`), then `ENV=prod pnpm db:seed`.
5. Register the number, subscribe the WABA, publish the Flow, create the `order_delivered` template (section 5), then run the smoke test.
