# Operations runbook

For the person who deploys and operates FixedItNow. It describes what exists in this repository; it does not describe a deployment that has been made. **Nothing here has been run against production.** Hosting is not chosen yet (the SRS asks for a provider decision "immediately before deploying", §14), so this runbook is provider-neutral and container-based. Related: [DEPLOYMENT.md](DEPLOYMENT.md) (setup and variables), [SECURITY.md](SECURITY.md), [PAYMENTS.md](PAYMENTS.md), [AI.md](AI.md), [AUDIT.md](AUDIT.md) (what was verified and what blocks launch).

## 1. What runs

| Service | Image (Dockerfile) | Port | Needs | Public? |
| --- | --- | --- | --- | --- |
| **web**: Next.js 16 | `frontend/Dockerfile` (standalone output, non-root) | 3000 | the API (server components call it at request time) | yes, behind TLS |
| **api**: NestJS 12 + Better Auth + Prisma | `backend/Dockerfile` target `runtime` (non-root) | 4000 | PostgreSQL 16+; optional SMTP, payment providers, AI service | yes, `/api/v1/*` behind TLS (**not** `/api/v1/internal/*`) |
| **migrate**: release job | `backend/Dockerfile` target `migrate` | none | PostgreSQL | **never** a long-running service |
| **ai**: FastAPI | `rag_agent/Dockerfile` (non-root) | 8000 | the API's internal endpoints; optional OpenRouter | **no**, private network only |
| **PostgreSQL** | managed service | 5432 | `btree_gist` extension (trusted on PG13+) | no |

Not used: Redis, a queue, object storage, WebSockets, a vector database. There is **no scheduler** and **no email/SMS/push notification service** (in-app notifications and the polling booking chat exist, see WORKFLOW.md).

```
Internet --TLS--> reverse proxy / CDN --/--------------> web :3000
                                       |--/api/v1/*---> api :4000 --> PostgreSQL
                                       '--/api/v1/internal/*  BLOCKED
web --(server components, BACKEND_URL)--> api            api --Bearer AI_SERVICE_TOKEN--> ai :8000
                                                          ai  --Bearer APP_API_SERVICE_TOKEN--> api /api/v1/internal/ai/*
                                                          ai  --HTTPS--> OpenRouter (optional)       api --HTTPS--> bKash / SSLCOMMERZ
```

Same-origin is required: the browser must see the web app and `/api/v1` on **one origin** (cookies are first-party, `SameSite=Lax`, origin-checked). Route `/api/v1/*` to the API at the proxy (preferred); the Next.js rewrite exists as a fallback and does not forward the client IP.

## 2. Configuration (names only; values belong in the host's secret manager)

Full tables with secrets marked: [DEPLOYMENT.md](DEPLOYMENT.md#environment-variables). Production-critical rules enforced at startup (the API refuses to start otherwise):

* `NODE_ENV=production`; `BETTER_AUTH_URL` and `FRONTEND_ORIGIN` are the public **https** origin; `BETTER_AUTH_SECRET` >= 32 random characters.
* `MAIL_TRANSPORT=smtp` with `SMTP_*` (console mail is refused in production). `TRUSTED_PROXIES` set (rate limiting needs the client IP). `RATE_LIMIT_ENABLED` cannot be `false`.
* Live payment flags (`*_IS_LIVE=true`) only with `NODE_ENV=production` and a matching live URL. Leave them `false` until the sandbox checklist in PAYMENTS.md is complete.
* AI: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `APP_API_SERVICE_TOKEN` together or not at all; two **different** secrets of >= 32 characters. The AI service itself: `APP_ENV=production` (default), the same two tokens, `APP_API_BASE_URL` = the API's **private** address, and optionally `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`.
* Operations: `DATABASE_POOL_MAX` (default 10; keep instances x pool below the database's connection limit), `DATABASE_CONNECT_TIMEOUT_MS` (5000), `DATABASE_STATEMENT_TIMEOUT_MS` (15000), `HTTP_LOG` (default on).
* Web image build args: `BACKEND_URL` (baked into the rewrite; also set at runtime), `NEXT_PUBLIC_SITE_URL` (production origin, inlined at build).

## 3. First deployment (authorised operator only)

Do this in **staging first** with the same images. Every step is a decision point; stop on any failure.

1. **Prerequisites.** Domain + TLS certificate; managed PostgreSQL 16+ with automated backups and point-in-time recovery; `CREATE EXTENSION btree_gist` allowed for the migration user; an SMTP provider with SPF/DKIM for the sender domain; secrets generated (`openssl rand -base64 32` for `BETTER_AUTH_SECRET`; `openssl rand -base64 48` for each service token) and stored in the secret manager. Create **two database roles**: a migration role (DDL) and an application role (DML only: SELECT/INSERT/UPDATE/DELETE on tables, no DDL, no TRUNCATE; this also stops anyone with the application's credentials from truncating append-only tables).
2. **Back up** the database (even an empty one: it proves the procedure), then **apply migrations** with the migration role from a one-off job, never from the running API:
   `docker run --rm -e DATABASE_URL=<migration-role-url> fixeditnow-migrate` (runs `prisma migrate deploy`). Add `npx prisma db seed` **only on a new database** (idempotent; creates the 10 service categories, no users or credentials). `migrate deploy` applies only unapplied, reviewed migrations. **Never** run `migrate dev`, `migrate reset` or `db push` against a shared database.
3. **Build and publish images** from the reviewed commit: `docker build --target runtime -t <registry>/fixeditnow-api:<sha> backend`, `docker build --build-arg BACKEND_URL=http://<api-private-host>:4000 --build-arg NEXT_PUBLIC_SITE_URL=https://<domain> -t <registry>/fixeditnow-web:<sha> frontend`, `docker build -t <registry>/fixeditnow-ai:<sha> rag_agent`. Tag with the commit; never deploy `latest`.
4. **Start** api (with the application-role `DATABASE_URL`), then ai, then web. Wait for health (below).
5. **Proxy rules:** `/` -> web; `/api/v1/` -> api; **deny** `/api/v1/internal/`; forward the real client IP in `X-Forwarded-For` (overwrite client-supplied values); redirect http to https; HSTS is sent by the web app.
6. **Grant the first administrator** from a trusted machine: `cd backend && npm run admin:grant -- you@example.com` (the user must exist and be verified). There is no other way to become an administrator.
7. **Smoke test** (section 5). Only then announce.

Local proof that the images work together: `backend/docker-compose.staging.yml` (disposable Postgres, one-shot migrate job, api, ai, web; see the file header). It was built and run during Step 10 (all containers healthy; see AUDIT.md); it is **not** a production deployment (no TLS, dead SMTP host).

## 4. Health, logs, alerts

* **Liveness** `GET /api/v1/health/live`: process up, no dependencies. **Readiness** `GET /api/v1/health` or `/health/ready`: database reachable within 2 s, else `503 {checks:{database:"unavailable"}}`. Use liveness for restarts and readiness for traffic. The AI service's `GET /health` reports `llm: configured|not_configured`. Neither reveals versions, hosts or errors. The AI service, payment providers and SMTP are **not** part of readiness: they degrade gracefully (assistant -> normal search; provider unavailable -> that method hidden).
* **Operator view** (admin session): `GET /api/v1/admin/ops/status` -> database ok, AI reachable/LLM configured, payment providers `not_configured|sandbox|live`, mail transport, and the queues that need a human (payments requiring review or unresolved > 30 min, refunds awaiting decision/provider, disputes, reports).
* **Logs** are one JSON object per line on stdout/stderr. API: `{"event":"http","requestId","method","route"(template),"status","ms"}` per request (probes excluded) and `{"event":"unhandled_error","requestId","name","code","frames"}` for unexpected errors; clients get the `requestId` in `X-Request-Id` and in 500 bodies, so a user report maps to one log line. The AI service logs `{"event":"ai_chat","correlationId",...}`; the correlation id **equals the API request id**. **Never logged:** query strings, bodies, cookies, message text, prompts, tokens, error messages with data, personal data. Ship logs to your provider's log service with 30-90 days retention; restrict access.
* **Recommended alerts** (the repository ships no monitoring stack): readiness failing > 2 min; API 5xx rate > 2% for 5 min; p95 latency > 1 s for 10 min; `unhandled_error` lines (any); `paymentsRequiringReview > 0` or `paymentsUnresolvedOver30Minutes > 0` for > 1 h; `refundsAwaitingProvider > 0` for > 1 day; database connections > 80% of the limit; disk > 80%; certificate expiry < 14 days; AI `reachable:false` for > 10 min (degraded, not an outage).

## 5. Post-deployment smoke test

Using a throwaway test account (delete or ignore it afterwards) unless a step says otherwise.

1. `GET /api/v1/health/ready` -> 200 `database: ok`; `/health/live` -> 200.
2. `GET /` and `/services`, `/workers`, `/help` -> 200 over https; response headers include `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`; no `X-Powered-By`.
3. `GET /api/v1/categories` -> 10 categories (seed ran). `GET /api/v1/internal/ai/categories` from the **public** internet -> blocked (404/401/403), never 200.
4. Register -> the verification email with a 6-digit code **arrives** (inbox, not spam) -> entering it logs you in -> `/account` loads; the same code fails a second time. Request a password reset -> email arrives -> reset works -> old sessions end. (Verifies SMTP, SPF/DKIM and the callback origin.)
5. If Google sign-in is enabled: "Continue with Google" completes and returns to the site (redirect URI registered exactly).
6. Admin: `/admin/moderation` loads for the administrator and answers 403 for the test account.
7. Publish a test professional (admin approves), search finds them, a booking request can be made and accepted.
8. **Payments (sandbox only until approved):** `GET /api/v1/payments/providers` shows each configured provider `available` and `mode: sandbox`; run the checklist in PAYMENTS.md "Sandbox verification". Never test with live credentials or real money until the business has approved.
9. AI (if enabled): `GET /api/v1/ai/status` -> `available:true`; `/admin/ops/status` -> `ai.reachable:true`; ask the assistant for a plumber -> real results or an honest "no match"; with the AI service stopped the chat shows the error and the normal search still works.
10. Logs show JSON request lines with request ids and **no** secrets, emails or message text.

## 6. Backup, restore, rollback

* **Backup:** managed point-in-time recovery plus a nightly logical dump (`pg_dump -Fc`), stored encrypted in a separate account/region, retained 30 days; **restore-test at least monthly**. Before every release that includes a migration, take and verify a fresh backup. Tested locally during Step 10 on a 9 MB dump of a 20,000-professional / 100,000-booking dataset: `pg_dump -Fc` 0.9 s, `pg_restore --no-owner` 3.7 s into an empty database, every table's row count identical, `prisma migrate diff` reported **no drift**, and the `btree_gist` extension, the `booking_no_overlap` exclusion constraint, CHECK constraints and the append-only triggers were all present after restore. (Managed-service restores differ in tooling; rehearse yours.)
* **Restore procedure:** create an empty database -> `pg_restore --no-owner --exit-on-error -d <new> <dump>` -> run `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` against it (must report no difference) -> point a staging API at it and smoke-test -> only then switch production, or restore into production with the service stopped. Payments and refunds recorded after the backup are lost from the database but exist at the providers: reconcile them (`POST /admin/payments/reconcile-stale`, then review `NEEDS_ATTENTION`) before reopening.
* **Application rollback:** redeploy the previous image tag (api, web, ai are stateless). It is safe only if the database schema is still compatible: all Step 5-10 migrations are **additive** (new tables/columns/triggers, no drops), so the previous application version keeps working on the newer schema. If a future migration is not additive, write its rollback before applying it.
* **Database rollback:** there are no down-migrations. A bad migration is handled by restoring the pre-release backup (accepting loss of newer data) or by a reviewed forward fix. This is why the backup before migrating is mandatory.

## 7. Incident playbooks

* **Database down / pool exhausted:** readiness fails and the platform stops routing; the API fails fast (5 s connect timeout, 15 s statement timeout) instead of hanging. Check connection count vs `DATABASE_POOL_MAX` x instances; restart only after the cause is understood.
* **Payments stuck or inconsistent:** `GET /admin/ops/status` queues -> `GET /admin/payments?status=NEEDS_ATTENTION` -> `POST /admin/payments/:reference/reconcile` (re-asks the provider; can discover a late success, cannot invent one). Never edit payment rows by hand. A payment in `REQUIRES_REVIEW` means money moved but could not be accepted automatically (amount/reference mismatch, duplicate): resolve it with the provider's merchant panel and refund through the app's refund workflow.
* **Provider outage:** that method shows unavailable at checkout; bookings can still be requested, accepted and worked, but finished jobs stay awaiting payment (`COMPLETION_PENDING`) and cannot be reviewed until the provider is back. Callbacks that arrive later are verified normally; run reconcile afterwards.
* **AI outage / OpenRouter errors or spend:** the assistant falls back to rule-based mode or the user is sent to the normal search. To stop spend immediately, unset `OPENROUTER_API_KEY` on the AI service (rule-based mode), or remove `AI_SERVICE_URL` from the API (assistant reports unavailable). Rotate the OpenRouter key if it may have leaked.
* **Suspected credential exposure:** rotate the affected secret at its provider, redeploy, and review logs. `BETTER_AUTH_SECRET` rotation signs every user out (acceptable). Service tokens rotate independently (set the new value on both sides, redeploy both). Payment credentials: rotate in the provider panel, then update the secret. Do **not** rewrite Git history to hide an exposure; rotation is the remedy.
* **Abusive content / reports:** `/admin/moderation`; every action is audited and append-only at the database level.

## 8. Known limitations an operator must know

No scheduler (lazy expiry; payment reconciliation is manual or via an authenticated cron calling the admin endpoints). No in-app messaging or notifications (users are not told about booking or moderation events except by email for account actions). No identity-document verification: "Profile reviewed" is a staff review of profile text. Rate-limit and creation-cap counters for non-auth routes are per process (run one API instance, or add a shared store, before scaling out). No monitoring stack, no Terms/Privacy pages (legal text required before launch), no account deletion or data export. See AUDIT.md for the full register.


## Admin panel operations

* **First admin / lock-out recovery:** `npm run admin:grant -- you@example.com` (needs `DATABASE_URL`; audited). If every super administrator is suspended, restore one directly in SQL (`UPDATE "user" SET "suspendedAt" = NULL, "suspensionReason" = NULL WHERE email = ...`) or run the script.
* **Audit integrity:** run Admin > Audit log > Verify (or `GET /admin/audit/verify`) on a schedule; copy `headSeq` + `headHash` to storage outside the database. A mismatch names the first bad sequence number. Restrict `TRUNCATE` and `ALTER TABLE ... DISABLE TRIGGER` on `audit_log` to a migration role the application does not use.
* **Document key:** store `DOCUMENT_ENCRYPTION_KEY` in the secret manager and back it up separately from database backups. Documents cannot be read without it.
* **Knowledge base:** after publishing documents press **Sync now** (or restart the AI service). `AI_KNOWLEDGE_SOURCE=api` must be set on the AI service for published documents to reach it.
