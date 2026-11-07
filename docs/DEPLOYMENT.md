# Setup and deployment

## Local development

Requirements: Node 24, PostgreSQL 16+ (Docker optional).

```bash
# 1. Database (either)
cd backend && docker compose up -d db     # postgres on 127.0.0.1:5433
#    ...or use any local Postgres and create fixeditnow_dev + fixeditnow_test

# 2. Backend
cp .env.example .env                      # then edit; never commit .env
openssl rand -base64 32                   # paste into BETTER_AUTH_SECRET
npm install
npx prisma migrate dev                    # applies backend/prisma/migrations to DATABASE_URL
npm run db:seed                           # service categories only
npm run start:dev                         # http://localhost:4000

# 3. Frontend
cd ../frontend
cp .env.example .env.local
npm install
npm run dev                               # http://localhost:3000
```

Open http://localhost:3000/register. With `MAIL_TRANSPORT=console` the
the 6-digit verification code and password-reset links are printed in the **backend terminal**.

### Making an admin
```bash
cd backend && npm run admin:grant -- you@example.com     # user must exist and be verified
npm run admin:grant -- you@example.com --revoke
```

### Tests
```bash
cd backend  && npm test && npm run test:e2e     # e2e needs TEST_DATABASE_URL (name must end in _test)
cd frontend && npm test
cd rag_agent && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest -q && .venv/bin/python -m evals.run_eval
```
The e2e runner **refuses** any database whose name does not end in `_test`
because it truncates tables.

## Environment variables

### Backend (`backend/.env`)
| Variable | Secret? | Notes |
| --- | --- | --- |
| `NODE_ENV` | no | `development` \| `test` \| `production` |
| `PORT` | no | default 4000 |
| `DATABASE_URL` | **yes** | PostgreSQL connection string |
| `TEST_DATABASE_URL` | **yes** | disposable DB, name ends `_test` (tests only) |
| `BETTER_AUTH_SECRET` | **yes** | >= 32 random chars |
| `BETTER_AUTH_URL` | no | **public web origin** (https in production) |
| `FRONTEND_ORIGIN` | no | same origin; used for origin checks |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ID no / **secret yes** | both or neither |
| `MAIL_TRANSPORT` | no | `console` (dev only) or `smtp` (required in production) |
| `EMAIL_FROM` | no | sender address |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` | no | |
| `SMTP_USER` / `SMTP_PASS` | **yes** | |
| `TRUST_PROXY` | no | reverse-proxy hops for Express (default 1) |
| `TRUSTED_PROXIES` | no | **required in production**; see below |
| `RATE_LIMIT_ENABLED` | no | cannot be `false` in production |
| `BKASH_BASE_URL` | no | bKash tokenized checkout v2 base URL; all five `BKASH_*` credentials or none. See [PAYMENTS.md](PAYMENTS.md) |
| `BKASH_APP_KEY` / `BKASH_APP_SECRET` / `BKASH_USERNAME` / `BKASH_PASSWORD` | **yes** | bKash merchant credentials |
| `BKASH_IS_LIVE` | no | default `false`; `true` only with `NODE_ENV=production` and a non-sandbox URL |
| `BKASH_AUTH_SCHEME` | no | `bearer` (default) or `raw` (unverified; see PAYMENTS.md) |
| `BKASH_REFUNDS_ENABLED` | no | default `false` |
| `SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` | id no / **password yes** | both or neither |
| `SSLCOMMERZ_IS_LIVE` | no | default `false`; `true` only with `NODE_ENV=production` |
| `SSLCOMMERZ_REFUNDS_ENABLED` | no | default `false` (needs SSLCOMMERZ IP whitelisting) |

### Frontend (`frontend/.env.local`)
| Variable | Secret? | Notes |
| --- | --- | --- |
| `BACKEND_URL` | no | where Next reaches the backend. Used (a) for the `/api/v1/*` rewrite, **read at build time**, and (b) by server components (`/workers`, `/services`, profiles) at **request time**. Set it for both `npm run build` and `npm start`. |
| `NEXT_PUBLIC_SITE_URL` | no | production origin; enables absolute OG URLs and sitemap |

Nothing secret is ever exposed to the browser: only `NEXT_PUBLIC_*` values are bundled.

### AI assistant variables (optional; see [AI.md](AI.md))
Backend: `AI_SERVICE_URL`, `AI_SERVICE_TOKEN` (**secret**), `APP_API_SERVICE_TOKEN` (**secret**), `AI_REQUEST_TIMEOUT_SECONDS` (30), `AI_RATE_LIMIT_PER_MINUTE` (10): all three of URL and tokens, or none (the API refuses to start otherwise). AI service (`rag_agent/.env.example`): `AI_SERVICE_TOKEN`, `APP_API_SERVICE_TOKEN` (the same two values), `APP_API_BASE_URL`, `OPENROUTER_API_KEY` (**secret**), `OPENROUTER_MODEL`, `OPENROUTER_RESPONSE_FORMAT`, limits. Run the AI service privately (`rag_agent/Dockerfile`); block `/api/v1/internal/` at the public proxy; keep `APP_ENV=production`.

### Operations variables (Step 10; all optional, see [RUNBOOK.md](RUNBOOK.md))
| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | 10 | Per API instance. Keep instances x this below the database connection limit. |
| `DATABASE_CONNECT_TIMEOUT_MS` | 5000 | Fail fast when the pool or database is exhausted. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 15000 | PostgreSQL cancels longer queries. |
| `HTTP_LOG` | on (off in tests) | One JSON access-log line per request: route template, status, duration, request id. Never query strings or bodies. |

## Containers, CI and the disposable staging stack (Step 10)

* `backend/Dockerfile` (targets `runtime` and `migrate`), `frontend/Dockerfile`, `rag_agent/Dockerfile`: non-root, health-checked images. On Vercel the web build now **fails** if `BACKEND_URL` is unset or points at localhost (it would otherwise ship a site that cannot reach its API). The web image bakes `BACKEND_URL` into the `/api/v1/*` rewrite at build time (`--build-arg BACKEND_URL=...`) and sets `NEXT_OUTPUT=standalone` itself; plain `npm run build` / `npm start` are unchanged.
* `backend/docker-compose.staging.yml` + `backend/staging.env.example`: a throwaway local stack (Postgres on tmpfs, one-shot migrate job, api, ai, web) to prove the images start and talk to each other. Not for production.
* `.github/workflows/ci.yml`: lint, typecheck, unit + integration tests (Postgres service container; the AI contract test runs against a Python venv), migration drift check, builds, `npm audit` / `pip-audit`, and a no-push image build. It uses no secrets and never deploys.
* Browser end-to-end checks (real Chrome, a scratch `*_qa` database): `frontend/e2e/README.md`.
* The production procedure, backup/restore/rollback, alerts and smoke tests: **[RUNBOOK.md](RUNBOOK.md)**. What was verified and what blocks launch: **[AUDIT.md](AUDIT.md)**.

## Google OAuth setup (Google Cloud console)

1. APIs & Services -> OAuth consent screen: choose External, set app name and support email, add scopes `openid`, `email`, `profile`. While in "Testing", add your Google account as a test user.
2. Credentials -> Create credentials -> OAuth client ID -> **Web application**.
3. Authorized JavaScript origins: `http://localhost:3000` (and your production origin).
4. Authorized redirect URIs (must match exactly):
   - development: `http://localhost:3000/api/v1/auth/callback/google`
   - production: `https://YOUR-DOMAIN/api/v1/auth/callback/google`
5. Put the client ID and secret in `backend/.env` (or your host's secret store), restart the backend. `GET /api/v1/config/auth` should report `googleEnabled: true` and the "Continue with Google" button appears.

The redirect URI uses the **web app's** origin because the web app proxies the callback to the backend.

## Email

Production requires `MAIL_TRANSPORT=smtp` with a real provider (any SMTP service). Configure SPF/DKIM
for the sender domain. Until SMTP is configured, users cannot receive the verification code and therefore cannot log in with a password.
Google sign-in does not need email. Full detail, including the Vercel setup: **[AUTH.md](AUTH.md)**.

## Production checklist

- HTTPS everywhere; `BETTER_AUTH_URL` / `FRONTEND_ORIGIN` are the https origin.
- **Route `/api/v1/*` to the backend at your reverse proxy / CDN** and have it set `X-Forwarded-For` to the real client IP (overwriting client-supplied values). The Next.js rewrite works for development but does not add the client IP.
- Set `TRUSTED_PROXIES` to the addresses of proxies **in front of the backend** whose forwarded chain should be skipped (CDN/LB ranges). If your single proxy appends the client IP and is the direct peer, set a placeholder such as `127.0.0.1` so the right-to-left walk is enabled. The backend refuses to start without it.
- Set `TRUST_PROXY` to the number of proxy hops.
- Run `npx prisma migrate deploy` (never `migrate dev`/`reset`) during release, after reviewing new migration SQL, against a backed-up database.
- Rate limiting and the per-user creation caps for non-auth routes are per-instance memory; run one API instance or add a shared store before scaling out.
- Block `/api/v1/internal/` at the public proxy (the AI service reaches it over the private network); health probes: `/api/v1/health/live` (liveness) and `/api/v1/health/ready` (readiness).
- Grant the first admin with `npm run admin:grant` from a trusted machine.
- Serve the web app and API on the **same site** (same origin recommended).
- Payments: leave every `*_IS_LIVE` at `false` until the sandbox checklist in [PAYMENTS.md](PAYMENTS.md) is done; `/api/v1/payments/callbacks/*` and `/api/v1/payments/ipn/sslcommerz` must be reachable by providers over https **without** a login wall or WAF challenge, while every other route stays protected; register the IPN URL in the SSLCOMMERZ panel; keep credentials in a secret manager, never in git.

## Search performance

Measured locally (single PostgreSQL 18 instance, 20,000 published profiles, 2 services each): directory
and filtered queries returned in roughly 5-20 ms; free-text search in roughly 40-70 ms (case-insensitive
substring scan over the published set). Before the directory grows well beyond ~100k profiles, add a
`pg_trgm` GIN index or a `tsvector` column (raw-SQL migration) for the text columns.

## Step 5 database requirements

`backend/prisma/migrations/20261025000000_step5_bookings` is **additive** (new tables and enums only; no existing table is altered or dropped) and
runs `CREATE EXTENSION IF NOT EXISTS btree_gist;` (required by the double-booking exclusion constraint). `btree_gist` is a *trusted* extension on
PostgreSQL 13+, so the database owner can create it; on managed databases (Neon, Supabase, RDS...) it is normally available, but **check before
deploying**. Review the SQL, back up, then `npx prisma migrate deploy`. Bookings are interpreted in Asia/Dhaka; the server clock must be correct (UTC).
There are no new environment variables.

## Step 6 database requirements

`backend/prisma/migrations/20261026000000_step6_payments` is **additive** (tables `payment`, `payment_event`, `refund`, three enums; no existing table is altered). Besides tables it creates
CHECK constraints, three partial unique indexes and an append-only trigger (`payment_event_append_only`, a PL/pgSQL function) that rejects UPDATE/DELETE on `payment_event`:
the database user running migrations must be allowed to create functions/triggers. No new extension is needed. Review the SQL, back up, then `npx prisma migrate deploy`.
**Never** `migrate reset`/`dev` against a database holding payment records. It was applied only to disposable local databases; `prisma migrate diff` reports no drift.
Because `payment_event` rows cannot be deleted, a test database is cleared with `TRUNCATE` (which the trigger does not intercept), never `DELETE`.

## Migrations

`backend/prisma/migrations/20261024000000_step4_discovery` (additive): adds nullable columns
`slug, publishedAt, suspendedAt, suspensionReason, startingPriceBdt` to `worker_profile`, the `favorite`
table, and indexes; it backfills `startingPriceBdt` from existing `worker_service` rows. No column is dropped
or rewritten; existing profiles stay **unpublished** until their owners publish. Review before `migrate deploy`.


`backend/prisma/migrations/20261023212432_init_auth_and_onboarding` creates all tables from scratch (the
database was empty). It was applied only to disposable local databases in this step. **No production database exists or was touched.**
