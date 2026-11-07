# Step 10 audit: readiness, findings and evidence

> A second, broader pass (all findings, fixes, test table, Vercel variables and the readiness decision) is in **[QA_REPORT.md](QA_REPORT.md)**. Where the two differ, QA_REPORT.md is newer.

Scope: the whole repository as it stood after Step 9, audited from the code, the database and running systems. Method: code review of every controller, service and guard; automated default-deny and abuse tests; a secret scan of history and tree; dependency audits; migration, backup and restore rehearsals on disposable databases; load measurement on a synthetic dataset; a real-Chrome run of the web app; and a build-and-run of the container images in a disposable staging stack.
**Nothing was deployed, pushed, committed or run against production, and no real payment, email or provider call was made.** Companion documents: [RUNBOOK.md](RUNBOOK.md) (operations), [SECURITY.md](SECURITY.md), [DEPLOYMENT.md](DEPLOYMENT.md).

## Verdict

**Ready for staging. Not ready for production.** The core marketplace (accounts, discovery, bookings, quotes, disputes, reviews, community, moderation, the assistant's grounding) is implemented, access-controlled and heavily tested against a real database. The blockers to launch are not code defects in what exists; they are things that do not exist or have never touched a real provider (below, "Launch blockers").

## Feature status

| Area | Status | Evidence / gap |
| --- | --- | --- |
| Public site, discovery, categories, search, filters, profiles, favourites | **Implemented and verified** | API integration tests; real Chrome crawl of 26 public pages (no dead links, no console errors, no CSP violations); measured 8-25 ms at 20,000 profiles |
| Registration, login, logout, sessions, verification, password reset | **Implemented and verified** with the console mail transport | API tests incl. rate limits, enumeration, revocation. **Real SMTP delivery: blocked** (no credentials) |
| Google OAuth | **Implemented, not externally verified** | State/PKCE/redirect/linking policy tested; a real login needs Google credentials |
| Customer and worker onboarding, admin review, publish/suspend | **Implemented and verified** | API tests; browser journey (request, accept) |
| Authorization (default deny, ownership, admin) | **Implemented and verified** | `test/route-audit.e2e-spec.ts` calls every route without a session; IDOR tests per domain |
| Availability, bookings, quotes, rescheduling, cancellation, disputes | **Implemented and verified** | Parallel-booking tests; DB exclusion constraint; browser journey |
| bKash and SSLCOMMERZ payments and refunds | **Implemented and tested against mocks only; blocked on real sandbox credentials** | No call to either provider was ever made. Several provider details are explicitly unverified (PAYMENTS.md) |
| **Booking-linked messaging and notifications** | **Booking-linked messaging: not implemented** (Step 7 was never built). *Update: in-app notifications, announcements and support tickets now exist (docs/ADMIN.md); email/SMS/push delivery does not.* | SRS FR-CHAT/notifications unmet; the UI no longer implies they exist. A launch decision, see blockers |
| Private media / identity documents | **Not implemented** | No upload route exists (asserted by test). "Profile reviewed" is a staff review of text, not an identity check |
| AI assistant (OpenRouter, RAG, grounding) | **Implemented and verified with mocks and a local fake model; real OpenRouter untested** | Real-process contract test; running containers (api <-> ai) in the staging stack; extraction quality of any real model unmeasured |
| Reviews, ratings, community, proposals, reports, moderation | **Implemented and verified** | API tests, mutation checks, real-Chrome flows |
| Admin: moderation console, ops status, audit history | **Implemented and verified** | Admin UI exists **only** for moderation; worker verification, payments/refunds and disputes are API-only |
| Audit logging | **Implemented and verified; made tamper-resistant in this step** | Append-only trigger (migration `20261028000000`), see F8 |
| CI/CD | **Added in this step, never executed on GitHub** | `.github/workflows/ci.yml`; every command it runs was run locally |
| Scheduled jobs (expiry, payment reconciliation) | **Not implemented** | Lazy expiry and manual/cron-called admin reconcile endpoints only |
| Monitoring / alerting stack, Terms and Privacy pages, account deletion and data export | **Not implemented** | Recommendations in RUNBOOK.md; legal text needs the business |

## Findings

Severity: P0 critical, P1 high, P2 medium, P3 low. "Fixed" means changed in the working tree and covered by a test or a measurement. Nothing was committed.

**No P0 finding.** No credential exposure (gitleaks over all 7 commits: no leaks; working-tree hits are the user's own git-ignored `backend/.env`, build output in `.next/`, and test fixtures). No authorization bypass, no payment-integrity flaw and no injection was found.

| # | Sev | Component | Finding and evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | **P1** | Product | **Messaging and notifications do not exist** (Step 7 skipped). Journeys A and B cannot be completed as specified; customers and professionals learn of events only by reloading. | **Open: needs a decision** (build it, or launch without and say so; the UI now says so) |
| F2 | **P1** | Payments, OAuth, SMTP, OpenRouter | None has ever run against the real service. Mocks prove our logic, not the providers' behaviour (e.g. what bKash does with an early `execute`; callback signature format; auth header scheme). | **Open: external credentials required** |
| F3 | P2 | Web | **Stale and false user-facing copy**: the FAQ said bookings were "not yet" available; "How it works" showed every step "Coming soon"; the home page promised "the conversation in one place" (no messaging exists); "Become a worker" listed live features as "coming later". | **Fixed** (`faqs.ts`, `how-it-works`, `become-a-worker`, home steps) |
| F4 | P2 | API | **No request correlation and unsafe default error logging**: no request id, no access log; Nest's default handler logs unexpected errors' messages and stacks, and Prisma messages can embed query parameters. | **Fixed**: `X-Request-Id` on every response, JSON access log of route templates only, `AllExceptionsFilter` (class, code, 5 frames; generic 500 with the request id); the request id is also the AI correlation id. Regression found and fixed while doing this: body-parser 4xx errors briefly became 500 (caught by the existing booking test) |
| F5 | P2 | API | **Single DB-only health route; no pool or statement limits**: pg pool defaults (no connect timeout), a runaway query could hold a connection forever; SMTP had default (minutes-long) timeouts. | **Fixed**: `/health/live` and `/health/ready` (2 s DB check), pool max / connect timeout / statement timeout env settings, bounded SMTP timeouts, admin-only `/admin/ops/status` for dependency and queue state |
| F6 | P2 | Web | **No Content-Security-Policy, COOP or HSTS.** | **Fixed**: CSP (same-origin only, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`, `form-action`), COOP, HSTS in production. Verified in real Chrome: 0 violations over a 26-page crawl. `upgrade-insecure-requests` was tried and **removed**: it broke a production build served over plain http (`ERR_SSL_PROTOCOL_ERROR`) |
| F7 | P2 | Database | **Community feed scanned whole tables**: Prisma `_count` compiles to a GROUP BY over every reaction/comment (and vote) for each page: 108 ms for any page at 100k reactions + 150k comments. | **Fixed**: counts scoped to the page's ids. Feed 108 -> 9 ms; proposals "new" 25 -> 5 ms; "top" 43 -> 25 ms (top still aggregates votes; acceptable at 200k votes) |
| F8 | P2 | Database | **`audit_log` was mutable** by any holder of the application's database credentials (only `payment_event` had a trigger). | **Fixed** by migration `20261028000000_step10_audit_log_integrity` (UPDATE/DELETE rejected except the FK's detach-actor on user deletion; tested incl. on a populated database). **Applying it to production needs authorization.** TRUNCATE is not intercepted: use a DML-only database role (RUNBOOK 3.1) |
| F9 | P2 | Ops | **No CI** (nothing ran lint/tests/audit automatically). | **Fixed**: `.github/workflows/ci.yml` (backend with Postgres service + Python contract test, frontend, AI service, image builds). **Not executed on GitHub yet** |
| F10 | P2 | Ops | **No deployable artifacts**: no Dockerfiles for api/web, no migration job, no staging stack. | **Fixed**: `backend/Dockerfile` (runtime + migrate targets), `frontend/Dockerfile`, `backend/docker-compose.staging.yml`; built and run (all containers healthy, API <-> AI <-> API over the container network, non-root users, no secret in any log) |
| F11 | P2 | Ops | **No scheduler**: stale payments and expiry rely on page reads or manual admin calls. | **Open** (documented; needs a job runner or an authenticated cron calling `POST /admin/payments/reconcile-stale`) |
| F12 | P2 | Product/legal | No Terms/Privacy pages, no account deletion or data export, no identity-document verification, limited admin UI (verification, payments, disputes are API-only). | **Open** (business decisions; listed as launch blockers) |
| F13 | P3 | Web | CSP allows `script-src 'unsafe-inline'` (Next's inline bootstrap scripts need a nonce otherwise, which would make every page dynamic). Mitigated because no user content is rendered as HTML (tests render `<script>`/`<img onerror>` payloads as text). | **Accepted, documented** |
| F14 | P3 | API | Rate-limit counters and per-user caps for non-auth routes are per process. | **Open**: run one API instance or add a shared store before scaling out |
| F15 | P3 | Payments | A premature "success" redirect (a customer opening the callback URL before approving) spends bKash's one-shot `execute` and closes that attempt as `FAILED`; the customer must start a new one. No money moves and a third party cannot do it (the 96-bit reference is unguessable). Whether bKash would still capture such a payment later is unverified. | **Documented**; test uses the realistic order; confirm in the sandbox |
| F16 | P3 | Build | API image is 1.16 GB (production `node_modules`); dev tools are one major version behind (TypeScript, Vitest, ESLint, `@types/node`), React 19.3.1 patch available. No vulnerabilities (`npm audit` 0 in both apps, `pip-audit` clean). | **Accepted**; update deliberately, not in a hardening step |
| F17 | P3 | AI | Bangla/Banglish extraction quality of a real model is unmeasured; rule-based fallback is limited by design. | **Open** (`python -m evals.run_eval --live` once a model is chosen) |

## Security review: what was checked

* **Authentication/sessions:** Better Auth with HttpOnly, SameSite=Lax, `Secure` in production, server-side sessions revoked on logout/reset, 7-day expiry, no cookie cache, scrypt hashing, enumeration-safe sign-up/reset, email verification required, rate limits per route (database-backed in production), origin and CSRF checks explicitly enabled (and asserted). OAuth: state + PKCE, redirect allow-list, no implicit account linking.
* **Authorization:** `AuthGuard` is global default-deny; the admin role is re-read from the database per request; `test/route-audit.e2e-spec.ts` walks the live router and requires 401 for every route not on a reviewed public list, 401/403/404 for admin and service routes with an ordinary session, and no CORS allowance anywhere. A mutation (making a controller public) fails it. Per-domain IDOR tests cover bookings, payments, reviews, community, proposals, favourites, profiles.
* **Input/output:** Zod on every body/query/param with strict objects (mass assignment is a 400), bounded pagination everywhere (every `findMany` is bounded; the few without `take` are per-resource and capped by constraints), Prisma parameterisation (no raw SQL with input), 100 kB body limit, plain-text-only user content with control/bidi characters rejected, generic error bodies.
* **Business logic:** prices and amounts come from stored booking/quote rows; payment success only via server-side provider verification (browser redirects and forged callbacks verified not to settle; parallel callbacks settle once; one paid payment per booking by unique index); refunds succeed only on provider confirmation; booking transitions through one state machine with an exclusion constraint against double booking; reviews need the customer's COMPLETED booking; votes, reactions and reports are unique per user by constraint; reporters' identities are never exposed; the AI cannot name a worker the database does not return.
* **Secrets/dependencies:** `.env*` git-ignored (only `.env.example` files tracked, placeholders only); gitleaks (history and tree), `npm audit` x2, `pip-audit`: clean. No credential needs rotation on the evidence available. Rotation procedures are in RUNBOOK.md.
* **Not testable here:** real-provider behaviour, TLS/proxy configuration, WAF, database role separation, secret-manager use, DNS/OAuth console settings, penetration testing by a third party.

## Performance (measured)

Synthetic dataset on a local PostgreSQL 18: 20,000 published professionals (2 services each), 100,000 bookings, 80,000 reviews, 50,000 posts, 150,000 comments, 100,000 reactions, 5,000 proposals, 200,000 votes, 20,000 reports. Single API process, 25 sequential requests per endpoint after warm-up, over HTTP on localhost (so these are server times, not network times; a different machine will differ).

| Endpoint | p50 | p95 |
| --- | --- | --- |
| `GET /workers` (first page / filtered / max page size 48) | 8.6 / 9.6 / 8.7 ms | 10.9 / 15.0 / 9.6 ms |
| `GET /workers?q=…` (text search, sequential scan) | 24 ms | 27 ms |
| `GET /workers/:slug`, `/reviews` | 1.9 ms, 2.9 ms | 4.8 ms, 6.2 ms |
| `GET /categories` (computed counts) | 12 ms | 13 ms |
| `GET /community/posts` page 1 / page 500, **before** -> after fix | 109 -> **9.3** ms / 101 -> **11.1** ms | 114 -> 12.8 / 125 -> 14.6 ms |
| `GET /feature-proposals` top / new, before -> after | 43 -> 25 ms / 25 -> **5.3** ms | 52 -> 29 / 30 -> 8.7 ms |
| `GET /admin/reports`, `/moderation/overview`, `/proposals?needsReview`, `/ops/status` | 17, 52, 85, 7 ms | 23, 71, 88, 8 ms |

No other endpoint needed a change. Not measured: concurrency or load (a single client was used), cold start, network latency, the AI service's model latency, frontend runtime metrics (Lighthouse). Frontend JavaScript: 434 KB gzip across all 38 chunks of the whole app (largest single chunk 70 KB gzip); no change was needed. The text search at 20,000 profiles is a sequential scan, as already documented; add `pg_trgm` before ~100k profiles.

## Verification record (Step 10)

See the section at the end of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#step-10) for commands and counts.

## Launch blockers (human decisions or external setup)

1. **Decide on messaging and notifications** (F1): build Step 7, or accept launching without in-app messaging and notifications.
2. **Real-provider verification** (F2): bKash and SSLCOMMERZ sandbox runs and merchant approval; SMTP delivery with SPF/DKIM; Google OAuth credentials and redirect URIs; OpenRouter key and a model whose endpoint supports the chosen response format, then `python -m evals.run_eval --live`.
3. **Legal**: Terms of Service and Privacy Policy text, data-retention and deletion policy for Bangladesh.
4. **Hosting and operations**: choose providers; TLS and proxy rules (block `/api/v1/internal/`); managed PostgreSQL with backups and a tested restore; separate migration and application database roles; log shipping, monitoring and the alerts in RUNBOOK.md; a scheduler for payment reconciliation; one API instance or a shared rate-limit store.
5. **Apply migrations** `20261027000000_step9_reviews_community` and `20261028000000_step10_audit_log_integrity` (both additive) to staging, then production, after a verified backup. Neither was applied to any shared or production database. `20261027000000` was applied to the local development database (`fixeditnow_dev`) during Step 9, and both were applied to disposable local databases for testing; the audit-integrity migration was **not** applied to the development database.
6. **Run CI once on GitHub** and fix anything environment-specific it finds.
