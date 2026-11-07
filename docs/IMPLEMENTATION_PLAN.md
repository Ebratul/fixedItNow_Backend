# Implementation plan

Roadmap phases follow [SRS.md](SRS.md) §15.

## Step 1: Git identity audit — done
## Step 2: Design system and public website — done (preview)

Pages: `/`, `/services`, `/workers`, `/how-it-works`, `/become-a-worker`,
`/about`, `/help`, `/contact`, 404 and error pages. (`/login` and `/signup` were
placeholders in Step 2; Step 3 replaced them with real auth, and `/signup` now redirects to `/register`.) `/privacy` and `/terms` are intentionally not created:
no approved legal text exists and none is invented.

Connected to real behaviour: navigation (header, mobile dialog, services
dropdown), hero search → `/workers` query params, category filter on
`/services`, FAQ disclosure, skip link.
Presentation-only / awaiting later steps: category data, professional data,
search results, login/signup, contact channels.

Dependencies added: `lucide-react` (icons). Dev: `vitest`, `@vitejs/plugin-react`,
`jsdom`, `@testing-library/*` (component tests); `@types/node` raised to ^24 to
satisfy Vitest peer ranges (runtime is Node 24).

### Verification performed
- `npm run lint`, `npm run typecheck`, `npm test` (13 tests), `npm run build`, `npm audit` (0 vulnerabilities).
- Real Chrome against the production build at 375, 430, 768, 1366, 1440 px on
  every route: no horizontal overflow, no console errors (other than the
  intentional 404 page).
- axe-core at 375 and 1440 px on every route: no violations.
- Interaction checks: mobile menu, Escape, dropdown (keyboard, outside click),
  search validation and navigation, category filter and empty state, all
  internal links resolve.

### Known gaps
- Bangla copy is not written yet; only the font fallback is in place (FR-PUB-04).
- No Lighthouse run; no cross-browser testing beyond Chromium.
- Toast and pagination components are not built (nothing uses them yet).
- Set `NEXT_PUBLIC_SITE_URL` in production for OG URLs and the sitemap.


## Step 3: Authentication, Google OAuth, onboarding, authorization — implemented (see status below)

**Architecture:** Better Auth inside a new NestJS 12 + Prisma 7 + PostgreSQL backend; web app proxies
`/api/v1/*`. Details: [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md), [SECURITY.md](SECURITY.md), [DEPLOYMENT.md](DEPLOYMENT.md).

**Routes (web):** `/login`, `/register` (`/signup` redirects), `/forgot-password`, `/reset-password`,
`/verify-email`, `/onboarding`, `/onboarding/customer`, `/onboarding/worker` (5-step wizard with saved
progress), `/account`.

### Status
| Capability | Status |
| --- | --- |
| Email/password registration, login, logout | **Implemented and verified** (API tests + real browser run) |
| Email verification (required before login) | **Implemented and verified** (console transport; SMTP verified against a local sink only) |
| Password reset (single-use, revokes sessions) | **Implemented and verified** |
| Sessions (HttpOnly/SameSite/Secure-in-prod, revocation) | **Implemented and verified** |
| Customer onboarding | **Implemented and verified** |
| Worker onboarding + submit for review | **Implemented and verified** |
| One account with both capabilities | **Implemented and verified** |
| Workers cannot self-approve; users cannot self-assign admin | **Implemented and verified** (tests) |
| Backend authorization (default-deny, admin, approved-worker, ownership) | **Implemented and verified** |
| Admin review API + audit log; `admin:grant` operator script | **Implemented and verified** (no admin UI) |
| Rate limiting (auth + API) | **Implemented and verified** locally; production needs a proxy + `TRUSTED_PROXIES` |
| Google OAuth | **Implemented, NOT externally verified.** Config/state/PKCE/redirect URI/errors/linking policy tested (stubbed Google token endpoint); a real login needs Google credentials |
| Email verification by one-time code (OTP) | **Implemented and verified locally** (expiry, 5-attempt limit, replay, cooldown, hourly cap, hashed storage, password binding, real-Chrome journey). Real email delivery NOT verified. See [AUTH.md](AUTH.md) |
| Real SMTP provider | **Implemented, NOT externally verified** (needs provider credentials) |
| Identity-document upload/verification | **Not implemented** (later step) |
| Terms/Privacy pages + acceptance | **Not implemented** (no approved text) |
| Admin UI, 2FA, email change, account deletion | **Not implemented** |

### Verification performed
- Backend: `npm run typecheck`, `npm run lint`, `npm test` (24 unit), `npm run test:e2e` (87 integration tests on a real PostgreSQL test database), `npm run build`, `npm audit` (0 vulnerabilities).
- Frontend: `npm run lint`, `npm run typecheck`, `npm test` (65 tests), `npm run build`, `npm audit` (0 vulnerabilities).
- Real Chrome against the running stack: registration -> emailed 6-digit code -> onboarding (customer + 5-step worker wizard, resume after reload) -> submit -> logout -> wrong/unknown-email login -> password reset (single-use) -> open-redirect `?next=` ignored.
- axe-core and horizontal-overflow checks on all auth/onboarding/account pages at 375, 430, 768, 1366, 1440 px: no violations.

### Known gaps
See [SECURITY.md](SECURITY.md) "Not done / known limitations".


## Step 4: Worker profiles, categories, search, filters, favorites — implemented

**Routes (web):** `/services` (API-backed categories with computed counts), `/services/[slug]`,
`/workers` (search + filters + sorting + pagination), `/workers/[slug]` (public profile),
`/account/favorites`. Owners publish/unpublish from `/onboarding/worker` once approved.

| Capability | Status |
| --- | --- |
| Categories from DB, active-only, computed counts, no write endpoints | **Implemented and verified** |
| Worker lifecycle: draft -> submitted -> approved -> published; admin suspension | **Implemented and verified** |
| Public directory + profile with strict visibility and private-field protection | **Implemented and verified** |
| Search (name/headline/bio/category), filters (category, location, max price, min experience), sorting, bounded pagination | **Implemented and verified** |
| Favorites (add/remove/list, unique, private) | **Implemented and verified** |
| Owner profile editing (strict validation, ownership) | **Implemented and verified** (reuses Step 3 wizard) |
| Responsive + axe checks on discovery pages | **Implemented and verified** (Chrome; 375/430/768/1366/1440 px) |
| Rating/review display, rating filter/sort | **Deferred** (no review data; shows "No reviews yet") |
| Availability filter | **Deferred** (no availability data) |
| Distance/map search, relevance ranking | **Deferred** (location is division-level text; sort is explicit) |
| Profile photos/uploads | **Deferred** (initials avatar; no upload endpoint) |
| Booking, payment, messaging, AI | **Not started** (later steps) |
| Admin category management UI | **Deferred** (categories are seed/migration managed) |
| Full-text/trigram index | **Deferred** (not needed at measured scale) |

### Verification performed
- Backend: typecheck, lint, 35 unit tests, 163 integration tests on a real PostgreSQL test DB, build, `npm audit`.
- Frontend: lint, typecheck, 87 tests, build, `npm audit`.
- Real Chrome: search, filters, chips, clear-all, pagination, category counts, profile page, favorites (logged-out redirect,
  login return, persistence after refresh, list, unfavorite), mobile filter toggle; axe + overflow sweep of 11 pages x 5 widths.
- Query timing against a 20,000-profile scratch database (see DEPLOYMENT.md).


## Step 5: Bookings, availability, quotes, cancellation, rescheduling, disputes — implemented

Design and rules: [BOOKINGS.md](BOOKINGS.md). Routes (web): `/workers/[slug]/book`, `/bookings`, `/bookings/[id]`, `/account/availability`.

| Capability | Status |
| --- | --- |
| Booking request (server-validated, price snapshot, idempotent) | **Implemented and verified** |
| Booking state machine, history/audit events, per-viewer allowed actions | **Implemented and verified** |
| Worker availability (weekly hours, time off), public slot list | **Implemented and verified** |
| Conflict prevention (lock + conditional update + DB exclusion constraint) incl. parallel tests | **Implemented and verified** |
| Quotes (create/revise/withdraw/accept/reject/expire) | **Implemented and verified** |
| Fixed/hourly accept; start/complete/confirm-completion | **Implemented and verified** |
| Cancellation (policy, reasons, slot release, payment-review marker) | **Implemented and verified** |
| Rescheduling (request/approve/reject/withdraw/expire) | **Implemented and verified** |
| Disputes (open, messages, withdraw, admin review/resolve/reject, audit) | **Implemented and verified** (admin: API only) |
| Customer/worker UI (form, list, detail, availability editor) | **Implemented and verified** (real Chrome, 375-1440 px, axe) |
| Admin disputes UI | **Not implemented** (no admin dashboard exists yet) |
| Notifications | **Not implemented** (no notification system; events stored) |
| Dispute evidence uploads | **Not implemented** (no private storage) |
| Scheduled expiry / auto-completion | **Not implemented** (lazy expiry only) |
| Payments, refunds | **Implemented in Step 6** (see below) |

### Verification performed
- Backend: typecheck, lint, 67 unit tests, 331 integration tests (real PostgreSQL), build, `npm audit` (0), migrations applied to an empty database and to a populated one, `prisma migrate diff` shows no drift.
- Mutation checks: disabling the participant check or the overlap protection makes the suites fail.
- Frontend: lint, typecheck, 109 tests, build, `npm audit` (0).
- Real Chrome: login redirect, request, accept, reschedule, quote, cancel (reason required), job start/finish/confirm, dispute + admin resolution, availability editor, no-hours worker, stranger access; overflow + axe sweeps at 375/430/768/1366/1440 px.

## Step 6: Payments, bKash, SSLCOMMERZ, verification, transaction records and refund workflow - implemented, NOT verified with real providers

Design, rules, state machines, configuration and the sandbox checklist: [PAYMENTS.md](PAYMENTS.md). Routes (web): `/bookings/[id]/pay`, `/payments`, `/payments/[reference]`.

| Capability | Status |
| --- | --- |
| Payment/refund tables, append-only `payment_event`, DB-enforced invariants (migration `20261026000000_step6_payments`) | **Implemented and verified** (local PostgreSQL, no drift) |
| Server-side initiation (amount from the stored agreed price, ownership/eligibility, idempotent, one open attempt) | **Implemented and verified** (integration tests) |
| bKash tokenized checkout v2 adapter (create, execute once, query, refund, refund status) | **Implemented and unit-tested** against mocked HTTP. **Not sandbox-tested** (no credentials). Disabled until configured. |
| SSLCOMMERZ v4 adapter (session, Order Validation API, lookup by tran_id, refund, refund status; IPN) | **Implemented and unit-tested** against mocked HTTP. **Not sandbox-tested.** IPN hash not implemented (unspecified). Disabled until configured. |
| Trusted verification, mismatch quarantine, duplicate/late/parallel callback handling | **Implemented and verified** (mocked providers; mutation checks) |
| Customer UI: checkout, honest provider availability, server-driven return/status page, history, refund request | **Implemented**; component-tested; **not exercised in a real browser this step** |
| Refunds: request, admin approve/reject/create/process/reconcile, provider-confirmed completion, over-refund guards | **Implemented and verified** (mocked providers) |
| Reconciliation: lazy re-verification, admin single/batch endpoints | **Implemented**; scheduled reconciliation **not implemented** (no job runner) |
| Admin UI for payments/refunds | **Not implemented** (API only) |
| Notifications / receipts | **Not implemented** |
| Worker payouts, escrow, commissions, deposits | **Out of scope; not built** |
| Manual (panel-made) refund recording | **Not implemented** |

### Verification performed
- Backend: typecheck, lint, 108 unit tests, 397 integration tests (real PostgreSQL; 66 are payments/refunds, run against a mocked provider network), build, `npm audit` (0), migration applied to an empty database and on top of the Step 5 schema, `prisma migrate diff` shows no drift.
- Mutation checks (change code, expect tests to fail): skipping the amount comparison, the ownership check, the foreign-`val_id` check, treating bKash `Initiated` as paid, and the execute-once claim each make tests fail.
- Frontend: lint, typecheck, 128 tests, build, `npm audit` (0).
- Runtime smoke through the Next rewrite: form-encoded SSLCOMMERZ POST and bKash GET callbacks reach the backend, answer `303` to the web app; IPN answers `200 OK`; unauthenticated and foreign-Origin requests are refused; `/payments` and `/bookings/:id/pay` redirect to login.
- **Not done:** any call to bKash or SSLCOMMERZ (sandbox or live); a real-browser pass of the new pages.

## Step 7: not started
(Messaging / notifications are still unbuilt. Step 8 does not depend on them.)

## Step 8: AI service discovery, RAG and safety - implemented, NOT verified with a real provider

Design, schemas, safety rules and limitations: [AI.md](AI.md). Routes (web): `/assistant` (login required). Service: `rag_agent/` (Python FastAPI). API: `POST /ai/chat`, `GET /ai/status`, internal `GET /internal/ai/{workers,categories}`.

| Capability | Status |
| --- | --- |
| Separate FastAPI service: validated intent extraction, rule-based fallback ("simple mode"), clarification, relaxation suggestions, knowledge answers with sources | **Implemented and tested** (offline) |
| Worker recommendations grounded in PostgreSQL (AI returns references; the API re-reads eligible workers under the stated filters) | **Implemented and verified** (integration tests on real PostgreSQL) |
| Read-only, token-guarded internal search tool reusing the public search code and `ELIGIBLE_WORKER` | **Implemented and verified** |
| OpenRouter adapter (structured outputs, `require_parameters`, error mapping, no fallback model) | **Implemented and tested against mocks and a local fake server.** **No real OpenRouter request was made; no real model was evaluated.** |
| Nest <-> Python over real HTTP (fake model) | **Implemented and verified** (`ai-contract.e2e-spec.ts`) |
| Curated RAG (BM25 over 7 public documents, 23 chunks) | **Implemented and tested.** No embeddings/vector store (not justified at this size). |
| Prompt-injection / privacy defenses, per-user rate limit, metadata-only logs | **Implemented and verified** (tests + mutation checks) |
| Frontend assistant (chips, suggestions, cards, relaxations, errors, normal-search fallback) | **Implemented and component-tested**; production build served `/assistant` (login redirect verified); **not exercised in a real browser** |
| LangChain / LangGraph, vector DB, persisted conversations, LangSmith | **Not used / not implemented**, with reasons in AI.md |
| Real-model extraction quality (English / Bangla / Banglish) | **Not measured** (`python -m evals.run_eval --live` exists, never run) |

### Verification performed
- Python (`rag_agent/`): `pytest` 123 passed, `ruff check` clean, `mypy --strict` clean, `pip-audit` no known vulnerabilities, offline evaluation 40/40 cases (see AI.md), Docker image built, ran as a non-root user and answered `/health`.
- Backend: typecheck, lint, 117 unit tests, 423 integration tests (real PostgreSQL; 19 AI route tests + 7 cross-process contract tests), build, `npm audit` (0), `prisma migrate diff` shows no drift (Step 8 adds no migration).
- Frontend: lint, typecheck, 141 tests (13 new), build, `npm audit` (0).
- Mutation checks (break a line, expect a test to fail): skip local re-verification, never refuse private requests, accept unretrieved citations, accept action claims, accept unknown categories, accept unverified cards, ignore the bearer scheme, skip the service-token check, index internal documents, unbounded retries (Python); skip the service token, hydrate without eligibility/filters, allow extra AI fields, allow external links, no per-user limit, no body validation (backend). Every one now makes a test fail (the bearer-scheme mutation initially survived, which led to a stronger test).
- **Not done:** any call to OpenRouter; a real-browser pass of `/assistant`; axe/overflow sweeps; native-speaker review of the Bangla strings.

## Step 9: Reviews, ratings, community, feature proposals, voting and admin moderation - implemented

Design, policies, state machines, API and limits: [COMMUNITY.md](COMMUNITY.md). Routes (web): `/community`, `/community/[id]`, `/community/proposals`, `/admin/moderation`; reviews on `/workers/[slug]`; review panel on `/bookings/[id]`. Migration `20261027000000_step9_reviews_community` (additive).

| Capability | Status |
| --- | --- |
| Booking-verified reviews (create / edit 14 days / withdraw), one per booking, DB constraints, parallel-safe | **Implemented and verified** |
| Real ratings (1-decimal average, count) on cards, search, favourites, profile and AI cards; one grouped query per page | **Implemented and verified** |
| Community posts, comments, idempotent likes, reports (unique per user/item, daily cap), proposals with one vote each | **Implemented and verified** |
| Admin moderation API + audit (same transaction), conflict-of-interest rules, proposal lifecycle, vote threshold = admin filter only | **Implemented and verified** |
| Web UI incl. admin moderation console | **Implemented, component-tested, and exercised in real Chrome at 5 widths (overflow + axe clean)** |
| Sentiment analysis | **Not built, deliberately** (privacy and evaluation reasons in COMMUNITY.md) |
| Separate moderator role; worker replies; moderation notifications; spam/profanity filters; rating sort/filter | **Not built** (deferred) |

### Verification performed
- Backend: typecheck, lint, 125 unit tests, 489 integration tests (real PostgreSQL), build, `npm audit` (0), `prisma migrate diff` no drift, migration applied to an empty database. Frontend: lint, typecheck, 158 tests, build, `npm audit` (0). Python (Step 8) regression: 123 tests.
- Mutation checks: 19/20 caught, 1 equivalent mutant (see COMMUNITY.md).
- Real Chrome pass: 35 page x width combinations clean; 8 flows passed. Not done: keyboard-only and screen-reader walkthroughs, load testing.

## Step 10: final audit, end-to-end testing, performance, deployment readiness - done; verdict: ready for staging, NOT ready for production {#step-10}

Findings register, feature-status matrix, measurements and launch blockers: [AUDIT.md](AUDIT.md). Operations (deploy, migrate, back up, restore, roll back, alerts, incidents, smoke tests): [RUNBOOK.md](RUNBOOK.md). Migration `20261028000000_step10_audit_log_integrity` (additive; **not applied to any shared or production database**).

| Capability | Status |
| --- | --- |
| Default-deny route audit, IDOR/mass-assignment/payment-bypass/duplicate/AI-adversarial journeys (API level, real PostgreSQL) | **Implemented and verified** |
| Request ids, JSON access log, safe error handling, liveness/readiness, admin ops status, DB pool and timeout limits | **Implemented and verified** |
| Append-only `audit_log` (trigger) | **Implemented and verified** on disposable databases; production application needs authorization |
| CSP/COOP/HSTS on the web app; stale UI copy corrected | **Implemented and verified in real Chrome** |
| Performance: community feed and proposal counts scoped to the page | **Measured** (109 -> 9 ms; 25 -> 5 ms) |
| Dockerfiles (api runtime + migrate, web, ai), disposable staging stack, GitHub Actions CI | **Built and run locally** (containers healthy, API <-> AI over the network); **CI never executed on GitHub** |
| Browser e2e suite (`frontend/e2e`) | **Implemented and run** (35 page x width combinations clean; 12 UI flows passed; 26-page crawl clean) |
| Messaging, notifications, scheduler, Terms/Privacy, account deletion, identity documents, monitoring stack | **Not implemented** (launch blockers or decisions; see AUDIT.md) |
| bKash, SSLCOMMERZ, Google OAuth, SMTP, OpenRouter against the real services | **Not verified: blocked on credentials** |

### Verification performed
- Backend: typecheck, lint, 128 unit tests, **517 integration tests** on real PostgreSQL (28 new this step: route audit, journeys A-D, ops, audit integrity), build, `npm audit` (0), `prisma migrate diff` no drift; migrations applied to an empty database and to a populated one; backup/restore rehearsal.
- Frontend: lint, typecheck, 158 tests, production build, `npm audit` (0). AI service: ruff, mypy, 123 tests, `pip-audit` clean.
- Secrets: gitleaks over 7 commits and the working tree, no real leaks.
- Mutation checks (this step): making a route public, leaking the error message, logging the full URL, and disabling the audit trigger each fail a test.
- Real Chrome (production build, scratch database): 7 pages x 5 widths with no overflow and no axe violations; 12 UI flows passed (booking request through the UI, professional accepts, review, community, proposals, moderation, access denial, no messaging UI); 26-page crawl with no dead links or CSP violations.
- Containers: api, ai, web and the migrate job built from the new Dockerfiles and run together in a disposable compose stack; health checks passed; non-root; no secret in any log; stack and images removed afterwards.
- **Not done:** CI on GitHub; any provider call; load/concurrency testing; Lighthouse; keyboard-only and screen-reader passes; third-party penetration test; production anything.

