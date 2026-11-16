# C2V — Session Handoff (for Claude)

> Purpose: if the working Claude session is lost, a new Claude session reads this file first and can
> resume the project without re-asking settled questions. Last updated: **2026-11-15**.
> Keep it current: update the "Current state" and "Next steps" sections whenever a task finishes.

## 1. What the project is

- **C2V** is a **multi-tenant WhatsApp commerce bot server** built by the user (a developer) for small
  D2C clients. One deployment, one database, many clients ("tenants").
- **First tenant: NutriFarm Eggs** (`tenant_id = nutrifarm`, Meta business portfolio
  `organic_nutri_farm`, business ID 2142758757126606). Sells farm eggs in packs (6/12/30) in Bangalore.
- Phase 1 (this repo, almost done): the bot server — customers order on WhatsApp, pay through a
  Cashfree payment link, and the server stores customers, orders, payments and chat messages.
- Phase 2 (next): a vendor web dashboard. Brief: `docs/phase2-dashboard-brief.md`.
- User-facing guide: `docs/user-guide.md`. Deployment steps: `docs/runbook.md`.

## 2. Key documents (read in this order)

1. This file.
2. Spec: `docs/superpowers/specs/2026-11-12-whatsapp-commerce-bot-design.md` (decisions §2, flows §3,
   Phase 2 admin needs §4, improvements backlog §9).
3. Plan: `docs/superpowers/plans/2026-11-12-whatsapp-commerce-bot-phase1.md` (Tasks 1–16; Task 13 ON
   HOLD, Task 14 RESCOPED, Task 16 has a status note).
4. SDD ledger (git-ignored, local only):
   `.superpowers/sdd/2026-11-12-whatsapp-commerce-bot-phase1/progress.md` — per-task briefs, reports,
   reviews. Trust it and `git log` over memory.
5. `docs/runbook.md`, `docs/inputs-needed.md`.

## 3. How the user wants to work (must follow)

- **Step by step.** After each task: stop, present a summary, wait for review and approval. Only then
  start the next task. Before starting any task, say what is needed from the user.
- **Commit only after approval.** Commit messages 2–3 lines max. End with these trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the current session's `Claude-Session:` line.
- **Discuss before changing** when the user questions a design ("let's first discuss").
- The user usually asks for a task's scope and explanation before approving implementation.
- **Secrets** live only in git-ignored `.env.dev` / `.env.prod`. Never print them, never put them in chat
  or commits. Before every commit run the secret grep (see §8).
- **Never touch or stage** `CLIENT_CHECKLIST.md` or `LEARNING.md` (user's private files).
  `.claude/skills/`, `.agents/`, `skills-lock.json` are git-ignored.
- The user may run `pnpm dev` on port 8080 — don't kill it. Use port 8081/8082 for test servers and stop
  them afterwards.
- Never mention internal agent IDs to the user.
- **Process used so far:** subagent-driven development — implementer subagent (sonnet; no commit, no
  staging, no network) → reviewer subagent → fix round → controller verifies `pnpm test`,
  `pnpm typecheck`, `pnpm build` → live check → present → commit + push on approval.

## 4. Repo, stack, commands

- Path `/Users/srirajdev/development/C2V_Product/C2V`, branch `feat/phase1-bot`, remote
  `github.com/Sriraj-dev/C2V`.
- Node 22, TypeScript strict, Hono (@hono/node-server), drizzle-orm + postgres-js, Supabase Postgres
  (Mumbai) used as plain Postgres, vitest + pglite, pnpm 10.7.1.
- Env: `.env.dev` (default) and `.env.prod`; every script loads `.env.${ENV:-dev}` →
  `ENV=prod pnpm <script>` targets production. Cloud Run reads Secret Manager, not files.
  **Both files currently point at the same Supabase DB** (user decision: no customers yet; revisit later).
- Scripts: `pnpm dev | test | typecheck | build | db:generate | db:migrate | db:seed |
  db:schedule-cleanup [--days N] | flows:publish <tenant> [--flow-id] [--draft] [--test-number] [--update-json] |
  samples:send --to <phone> [--via test|bot] [--only ...] | cashfree:check create|status |
  checkout:test --to <phone> [--via test|bot] [--expiry-minutes N] |
  orders <tenant> <orderCode> assign <phone>|out-for-delivery|delivered|cancel|refund |
  vendors create <tenantId> <username>|reset-password <username>|deactivate <username>|activate <username>`.
- Local live testing: ngrok → port 8081; run
  `PORT=8081 NUTRIFARM_WA_PHONE_NUMBER_ID=1444268992103737 NUTRIFARM_WABA_ID=1170580189253457 npx tsx --env-file-if-exists=.env.dev src/index.ts`
  (points the bot at Meta's test number). ngrok URL changes per session → update `PUBLIC_BASE_URL` in `.env.dev`.
- Docker inside Claude's sandbox: the `desktop` credential helper hangs → run docker with
  `DOCKER_CONFIG=<scratch dir with {} config.json>`. Not needed on the user's own terminal.

## 5. Architecture (short)

- `src/ingress/` — `GET/POST /webhooks/whatsapp`, `POST /webhooks/cashfree`, `GET /health`.
- **Tenancy:** constant tenant config lives in code (`src/tenants/<id>/config.ts` + `copy.ts`), registered in
  `src/index.ts`. WhatsApp webhooks resolve the tenant by `phone_number_id`; Cashfree webhooks resolve it from
  the payment/subscription row, then verify the signature with *that tenant's* Cashfree secret. Both webhook
  endpoints are shared by all tenants. Every business table has `tenant_id`; the `tenants` table holds only
  vendor-editable values (support phone, delivery fee, min order, welcome image).
- `src/bot/` stateless router (menu buttons, Flow submits, location). `src/orders/` (order-service,
  checkout, order-status), `src/payments/` (`PaymentProvider` port + Cashfree adapter), `src/channels/whatsapp/`.
- Ordering UI = WhatsApp Flow without data endpoint (8 fixed product slots). Order summary + **Pay ₹X** CTA
  button arrive in chat after submit. Payment link expiry 30 min; `notify_url` is set per link from
  `PUBLIC_BASE_URL` (no Cashfree dashboard webhook needed).
- Order statuses: `payment_pending → confirmed → assigned → out_for_delivery → delivered`, plus `cancelled`,
  `payment_failed`, `expired`. Transitions enforced in `src/orders/order-status.ts` (race-safe conditional updates).
- Money in integer paise. Order code like `NF-7K3QX9`.
- Messages retention: pg_cron job `purge-old-messages` (`30 21 * * *` UTC = 03:00 IST) deletes messages
  older than 3 days. Already scheduled on the Supabase DB.
- RLS enabled (no policies) on all 11 tables — Supabase public Data API sees nothing; the server connects
  as `postgres` (BYPASSRLS) and is unaffected.

## 6. External accounts and IDs (no secrets)

- Meta app **"C2V"** receives WhatsApp webhooks for this product. The user's other product (**OMS**) uses a
  separate Meta app, so changing C2V's webhook never affects OMS.
- Bot number **+1 555-749-4425**: phone_number_id 1414838555047142, WABA 2294321858083581 (Organic Nutri Farm
  Messaging Account; account review APPROVED, business verified). Display name "Organic Nutri Farm" is still
  `AVAILABLE_WITHOUT_REVIEW` → sending blocked (131037). **Will be replaced by a real number** the user adds.
- Meta test number +1 555-189-6159: phone_number_id 1444268992103737, WABA 1170580189253457
  (`scripts/lib/meta-test-number.ts`). Free-form sends need the 24 h window.
- Flows: `order_v1` 1140197861942511 (DRAFT, bot WABA), `order_v1_test` 1145033461233367 (test WABA).
  Publishing blocked by Meta `139000/4233020 "Integrity requirements not met"`.
- Templates on WABA 2294321858083581: `order_delivered` (id 1473962084845503, lang `en`, UTILITY,
  "Your order {{1}} has been delivered. Thank you for ordering from Organic Nutri Farm! 🥚") — **PENDING**
  approval as of 2026-11-15; `out_for_delivery_template` (APPROVED, en_US, not used yet — backlog #17).
- Cashfree: client's account; **sandbox** keys in `.env.dev` and (for now) `.env.prod`. Production keys at go-live.
- Supabase project (Mumbai) — one DB for now.
- Seed: support phone 918310901383; delivery partner Ravi 919398651343; products White Eggs 6/12/30 pack
  ₹90/₹168/₹390; pincodes 560034, 560102, 560076 (Wed), 560068, 560037 (Sat).

## 7. User decisions (settled — don't re-ask)

- Delivery fee ₹0; minimum order ₹90; no cutoff; ordering on the delivery weekday → next week's date.
- BSUID-only customers (no phone) are asked for a mobile number in the order Flow.
- My Orders shows "Payment pending" orders (with a reassurance note); hides expired/payment_failed.
- **Subscriptions ON HOLD** (Task 13, subscription charges, subscription cancel). Schema/copy support them.
- Pending-payment reconcile job deferred (backlog #14). Expired links are handled by Cashfree's EXPIRED webhook.
- No email alert for "refund needed"; instead a **Needs refund** list in the Phase 2 dashboard.
- Out-for-delivery customer message deferred (backlog #17).
- **Cancel and refund stay separate** (cancel = status only; refund = money back via Cashfree, also cancels
  if not yet delivered). Cancelled-but-paid orders surface in the Needs refund list.
- Webhook settings for the Meta test number are not to be changed.
- Same Supabase DB for dev and prod until real customers exist.
- `.env.dev` / `.env.prod` split.
- Deploy target: Google Cloud Run, asia-south1. The user will create the GCP project.

## 8. Pre-commit secret check

Before every commit, grep the staged files for secret values. The exact command (it contains fragments of real
secrets, so it is **not** in git) lives in the local, git-ignored file `.superpowers/secret-check.sh`. Run
`bash .superpowers/secret-check.sh`; it must print nothing. If that file is missing, grep the staged diff for the
values of every variable in `.env.dev` / `.env.prod` (e.g. `git grep --cached -nF "$NUTRIFARM_CF_SECRET"`).

## 9. Current state (2026-11-15)

Commits on `feat/phase1-bot`: T1 78be3c4 · T2 8433bff · T3 8591414 · T4 c630e4c · T5 c688b8d · T6 662b44b ·
T7 e29f3e0 · T8 417ab5d · dev tools d3c571d · T9 9c4d26d · T10 cf7f64c · T11 9015c23 · T12 1a48af9 ·
T14 c5832d4 · **T15 53ce146** (order status ops, delivered template, refunds, `pnpm orders` CLI).

Built and verified live (sandbox): order Flow → pending order → Pay link → Cashfree PAID webhook → confirmed +
location request; EXPIRED webhook → order expired + customer message; My Orders; assign → out for delivery →
delivered; sandbox refund (idempotent).

**Task 16 local half — implemented, reviewed, verified, NOT yet committed (awaiting user approval):**
Dockerfile (+ .dockerignore; verified /health and graceful SIGTERM; 418 MB), `.env.dev`/`.env.prod` split,
`.env.example`, env banner in data-changing scripts, `JOBS_SECRET` optional, graceful shutdown, RLS migration
`0003` (**already applied** to Supabase), `docs/runbook.md`. Also new docs: this file, `docs/user-guide.md`,
`docs/phase2-dashboard-brief.md`.

**Admin API (2026-11-15/16):** branch `feat/admin-api` (off the phase 1 work) is **complete through Task 9**: vendor
login/sessions, orders and actions, customers, catalogue, settings, partners with private links, partner
`/partner/:token` API, chats. Contract: `docs/admin-api.md` (the dashboard team reads only this). Migration `0004`
is **applied to the shared Supabase DB** (2026-11-15), vendor login `nutrifarm` exists, live smoke passed, Ravi's
partner link generated. Operator CLI: `pnpm vendors create|reset-password|deactivate|activate`.

Subscribe menu item now replies "under development, coming soon" (subscriptions on hold). Dashboard auth preference: operator-generated username + password per client, no Google auth (see brief §7). Fourth doc: `docs/client-onboarding.md`.

## 10. Next steps

0. **Admin API:** final whole-branch review of `feat/admin-api`, then merge; build the dashboard in the separate
   repo `C2V_AdminDashboard` (it calls the admin API from its server side, `lib/api`, bearer token in an httpOnly
   cookie; see `docs/phase2-dashboard-brief.md`); then Task 16 cloud deploy (below).
1. Get approval and commit Task 16 local half + the three docs.
2. **Task 16 cloud half** (needs user inputs): user creates GCP project → Cloud Run deploy with Secret Manager
   (runbook) → set `PUBLIC_BASE_URL` in `.env.prod` and redeploy → user adds the **real phone number** (display
   name review) → set app C2V webhook to `https://<run-url>/webhooks/whatsapp` → point `.env.prod`
   `NUTRIFARM_WA_PHONE_NUMBER_ID`/`NUTRIFARM_WABA_ID` at the real number → make sure `order_delivered` exists
   (approved) on the real number's WABA → publish order Flow (when Meta lifts the block) → Cashfree production
   keys → real-phone smoke test.
3. The user has "a few things to add" after Task 16 — ask for them.
4. Phase 2 dashboard (separate session; brief in `docs/phase2-dashboard-brief.md`).
5. Backlog: spec §9 (human takeover, backups, paid-after-close message + refund, reconcile job,
   out-for-delivery template, subscriptions, ...).
