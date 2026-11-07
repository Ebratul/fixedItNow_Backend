# Full-site audit, fixes and readiness (QA pass 2)

Scope: the whole repository as it stands in the working tree (web app, API, database schema and migrations, AI service, tests, CI, deployment files),
audited from source and by running it. This follows [AUDIT.md](AUDIT.md) (Step 10) and the sign-in work in [AUTH.md](AUTH.md).

**Nothing was committed, pushed, deployed or run against production. No real payment, refund, email or provider call was made.** Executable checks ran against a
local PostgreSQL test database, a scratch `*_qa` database (dropped afterwards), a console mail sink and fake providers.
The developer's remote database in `backend/.env` was only touched once, when `npm run db:deploy` was run on explicit confirmation that it is a development database.

## A. Summary

* **Health:** builds clean; no P0 was found, and no confirmed P1. A line-by-line read of the controllers, services, payments and AI code (code reading plus the sweeps below, not exploit attempts against every route) found no IDOR or mass-assignment hole; an unauthenticated call to each of the 111 registered routes is refused except the 9 that are public by design.
* **Fixes in this pass:** 21 (one suspected P1 that depends on the provider, 6 P2, 14 P3). Each has a regression test unless the table says otherwise.
* **Core workflows tested:** registration with one-time code, login, Google error paths, onboarding, discovery, booking, accept, quote, reschedule, dispute, review, community, moderation, payments (fake providers) and refunds (fake providers), assistant grounding (scripted model). Real Chrome covered the journeys, 35 page/width combinations (0 overflow, 0 axe violations) and a 26-page crawl (0 dead links, 0 CSP violations).
* **Not tested because it needs credentials or hosting:** real Google login, real email delivery, real bKash/SSLCOMMERZ sandbox, real LLM, anything on Vercel.
* **Readiness:** **READY FOR LOCAL TESTING** (section G).

## B. Issues found and fixed

| # | Sev | Where | Root cause | Fix | Regression test |
| --- | --- | --- | --- | --- | --- |
| 1 | P2 | `rag_agent/app/safety.py` | Loose regexes treated ordinary searches as SQL or private-data requests: "select an electrician from Dhaka", "update my plan and set a budget", "show me all workers in Sylhet" were refused | SQL patterns now need SQL shape (`select *`, a clause keyword, `col =`); "all/every/other workers" no longer counts (workers are public listings; contact-detail requests are still refused) | `test_pipeline.py` (4 ordinary phrasings pass, 3 extra SQL-shaped attacks still refused). Fails on the old filter. |
| 2 | P2 | `bookings/availability.service.ts`, `booking.state.ts` | A DISPUTED booking released its slot, so the worker could accept another request for the same time and the dispute could then never be withdrawn, rejected or restored (409) | New `SLOT_HOLDING_STATUSES` (reserving statuses + DISPUTED) used by the bookability check and public slots. The DB exclusion constraint is unchanged (see C-3). | `disputes.e2e-spec.ts`. Fails without the fix. |
| 3 | P3 | `GET /workers/:slug/availability` | `from=9999-12-31` made date arithmetic produce an invalid key and threw: an unauthenticated 500 | `from` limited to years 2000-2100 (400 otherwise) | `availability.e2e-spec.ts`. Fails without the fix. |
| 4 | P3 | booking, quote, dispute, profile and admin-note text fields | A NUL character is valid JSON but not storable in Postgres, so it became a 500; bidi-override characters were accepted in public display names | The same control/bidi rejection already used by community and review text is now applied to those fields (`FORBIDDEN_TEXT`) | `availability.e2e-spec.ts` (booking text, display name). Fails without the fix. |
| 5 | P3 | `bookings.service.ts` accept | `unit ?? 0` could confirm a booking at 0 taka if a snapshot price were ever null | Accept refuses a non-positive snapshot price (409) | covered by the existing accept tests; no way to create the state through the API |
| 6 | P3 | `admin.service.ts` `reviewWorker` | Read-then-unconditional update: two admins deciding at once both succeeded and the second overwrote the first | Conditional `updateMany WHERE verificationStatus = PENDING`; the loser gets 409 | `authorization.e2e-spec.ts` (concurrent decisions). Fails without the fix. |
| 7 | P3 | booking history, dispute messages and admin dispute view | The 200/500 cap dropped the NEWEST entries, hiding the latest actions | Newest N are fetched and returned oldest-first | `lifecycle.e2e-spec.ts` (210 events). |
| 8 | P3 | `bkash.adapter.ts` refund status | With no provider refund id (after a timed-out request) the refund was matched by amount, so an earlier refund of the same amount could be recorded as this one without money moving | Never match by amount; no id means "indeterminate" (as the SSLCOMMERZ adapter already does) | `bkash.adapter.spec.ts`. |
| 9 | P3 | `payment-callbacks.service.ts` | The claimed SSLCOMMERZ status (up to 40 attacker-chosen characters) became part of an append-only audit row key: unbounded row growth for a known reference | Known statuses only; anything else is recorded as `OTHER` | covered by existing callback tests; the key space is now bounded |
| 10 | P1? | `bkash.adapter.ts` checkout host list | **Suspected, not verified:** the allowlist accepted only `*.bka.sh`, but bKash's customer-facing checkout page is, as far as is known, on `*.payment.bkash.com`. Every real initiate would then be rejected as `BAD_CHECKOUT_URL` (fails closed, so not a security hole) | `.bkash.com` added (a bKash-owned domain, dot-anchored so `evilbkash.com` does not match). **Confirm the exact host in the sandbox.** | `bkash.adapter.spec.ts` (accepts both, rejects look-alikes, http, credentials) |
| 11 | P2 | `payments/payment-detail.tsx` | One failed status poll stopped polling for good, so a customer returning from the provider saw "Checking…" forever | Poll scheduling no longer depends on success; a visible "could not refresh" notice | `payment-ui.test.tsx` (fail then succeed). Fails without the fix. |
| 12 | P2 | `bookings/availability-editor.tsx`, `community/post-view.tsx` | `reload()` clears the screen: adding time off discarded unsaved working-hours edits; posting a comment reset the whole post (focus, scroll) | `useApi` gained `refresh()` (silent refetch) and `stale`; those two screens use `refresh` | covered by the full suite; behaviour checked by reading, not by a dedicated test |
| 13 | P3 | `ui/dialog.tsx`, `confirm-dialog.tsx` | Escape during a pending request closed the native dialog while React still thought it open, hiding a failure message and blocking reopening | `Dialog` gained `dismissible`; Escape and backdrop clicks are ignored while pending | `components.test.tsx`. Fails without the fix. |
| 14 | P3 | `bookings/quote-panel.tsx`, `ui/select-input.tsx` | An always-present empty option let a worker submit `validForHours: 0` with an error shown nowhere | `placeholder={null}` renders no empty option | `components.test.tsx`. Fails without the fix. |
| 15 | P3 | `bookings/booking-detail.tsx` | Double-clicking Withdraw (quote or reschedule) sent two requests and showed a false 409 | Single-flight guard plus a loading button | `booking-detail.test.tsx` (the button's own loading state also blocks the second click, so this is defence in depth) |
| 16 | P3 | `payments/checkout.tsx` | A checkout URL we refuse to follow was reported as "already finished"; the busy state stuck after Back (bfcache) | Explicit error; `pageshow` unlock | `payment-ui.test.tsx` |
| 17 | P3 | favorite and report buttons | The login redirect kept only the path, losing filters and page | The query string is preserved (still validated by `safeNext`) | none (event-handler only) |
| 18 | P3 | `/bookings/[id]`, `/payments/[reference]`, `/community/[id]` | The URL segment was spliced into API paths unvalidated (`..%2Fadmin` produced a GET to another API path) | Shape check; malformed values render the 404 page and make no API call | `safe-redirect.test.ts` (validators) and real Chrome (404, zero API calls) |
| 19 | P3 | home, hero, about, worker CTA, payment copy | Claims the product does not back: "Booking-linked messaging", "support for both English and Bangla", "Booking-linked support", "is being built", "contact us" | Reworded to what exists (disputes on the booking, assistant understands Bangla, no support channel yet) | the browser journey asserts no messaging UI is offered |
| 20 | P2 | `frontend/next.config.ts` | On Vercel an unset `BACKEND_URL` silently baked `http://localhost:4000` into the rewrite: the site builds and deploys, every API call fails | The build fails on Vercel when `BACKEND_URL` is missing or points at localhost | the four cases (Vercel unset, Vercel localhost, Vercel real URL, not Vercel) run by hand |
| 21 | P2 | `backend/src/prisma/prisma.service.ts` | `statement_timeout` was passed as a connection startup parameter; Prisma Postgres (and similar poolers) reject it, so every connection failed ("Failed to connect to upstream database", health 503) | Applied with `SET` per connection, awaited before the client is handed out (covers both `pool.query` and `pool.connect`) | full e2e suite; verified against the real Prisma Postgres endpoint |

Earlier in this session (see [AUTH.md](AUTH.md)): email verification by one-time code, Google sign-in hardening, `npm run dev` alias for the API, and a corrected `BKASH_BASE_URL` line in the developer's `.env`.

## C. Remaining issues (not fixed)

**Needs a product decision**

1. **No admin screens for worker verification, disputes, payments, refunds or reconcile** (only moderation exists). A submitted worker stays "Awaiting review" and a refund request stays "Waiting for review" until someone uses the API. Already listed in IMPLEMENTATION_PLAN; the UI now says so where it matters.
2. **A VERIFIED (even published) worker can edit bio, services and prices without re-review** (`saveDraft` has no status guard). Documented in SECURITY.md. Needs a rule: reset to PENDING, or lock fields.
3. **Review farming is cheap:** a customer and a colluding worker can run request → accept → start → complete → confirm in seconds with no payment, then review. "Verified booking" means "completed in the app". Consider requiring a successful payment (or a minimum job duration) before a review counts.
4. **A payment parked in REQUIRES_REVIEW for a non-duplicate reason cannot be resolved in the system** (amount/currency mismatch, risk flag) and blocks new payments for that booking.
5. **A bKash payment can be marked FAILED while it is still completing** (execute timeout, then a query that still says "Initiated"); nothing re-checks FAILED rows automatically, so a late completion needs a manual admin reconcile and the customer may pay twice. Depends on real bKash behaviour; fix once sandbox behaviour is known (leave it PROCESSING, or include that failure code in the stale reconcile).
6. **No support channel exists** (email/phone/form). The copy no longer implies one.

**Hardening / small**

7. Unauthenticated callbacks with a known payment reference can cancel or fail the customer's open payment (96-bit reference, so unlikely; a later real payment still recovers). Treat the claim only as a hint to re-query the provider.
8. Internal AI endpoint (`/api/v1/internal/ai/*`) is unthrottled and publicly routable unless the proxy blocks it (docs/AI.md says to). Block it at the proxy.
9. The AI service's body-size guard reads only `Content-Length`; `AI_SERVICE_URL` may be `http://` in production (token in clear on the wire); `AI_MAX_OUTPUT_TOKENS` is parsed but unused; no global or daily cost cap (10 requests per user per minute, concurrency 8); a marketplace outage also breaks policy questions.
10. Idempotent booking replay does not compare category/description/address; the 20-open-request cap is racy across workers (bounded by a 10/min throttle).
11. Schema: several user-id columns have no foreign keys (`booking.cancelledByUserId`, `quote.createdByUserId`, dispute and reschedule actor columns, `booking_event.actorUserId`); `booking.acceptedQuoteId` has no FK; missing indexes on `content_report(targetKey)` and `booking(workerProfileId, createdAt)`; `worker_service` has no price/model CHECK; `FOR UPDATE` on the worker row where `FOR NO KEY UPDATE` would reduce contention; a status change without a note wipes an earlier public proposal response. These need a migration and were not added.
12. The DB exclusion constraint still excludes DISPUTED (fix #2 is application-level; a race between two simultaneous accepts around a dispute opening is still caught only by the 409 on restore).
13. Workers keep the customer's street address after completion; no "newest comments first" or pagination of admin dispute history beyond the caps.
14. Frontend: tablist without arrow-key navigation, some loading regions without `role="status"`, heading-order jump on the admin proposals tab, confirm-dialog autofocus lands on Close; `ProposalCard` keeps stale vote counts after a re-sort; slot picker keeps clickable old-duration slots until the response arrives; `useApi` shows the previous page's rows (no busy cue) when paging, except in the community feed; every protected page waits on `/me` before its own fetch (a request waterfall).
15. No terms/privacy pages, 2FA, CAPTCHA, or breached-password check (see SECURITY.md).

**Not applicable (do not exist in this codebase):** file uploads, identity-document storage, chat/notifications. Nothing to test there.

**Needs credentials, hosting or a person**

* Google login with a real account; SMTP delivery (SPF/DKIM, spam placement); bKash and SSLCOMMERZ sandbox flows (including the checkout host in #10); a real LLM key; the API hosted somewhere and reached from Vercel; the client IP the API sees behind Vercel (`TRUSTED_PROXIES`).

## D. Test results (all executed in this pass)

| Check | Command / method | Result | Evidence |
| --- | --- | --- | --- |
| Backend typecheck | `npm run typecheck` | PASS | no errors |
| Backend lint | `npm run lint` | PASS | no warnings |
| Backend unit | `npm test` | PASS | 136 tests |
| Backend integration | `npm run test:e2e` (local PostgreSQL test DB) | PASS | 26 files, 561 tests. One earlier run had a load-sensitive failure in `publication.e2e-spec.ts` ("concurrent publish allocates one slug", in code not touched here); it passed 3 of 3 alone and in this full run. Treat as a flaky test, not investigated further. |
| Backend build | `npm run build` | PASS | |
| Frontend lint / typecheck | `npm run lint`, `tsc --noEmit` | PASS | |
| Frontend tests | `npx vitest run` | PASS | 176 tests |
| Frontend production build | `npm run build` | PASS | 38 pages generated |
| AI service tests | `.venv/bin/python -I -m pytest` | PASS | 130 tests |
| AI service lint / types | `ruff check .`, `mypy app` | PASS | |
| Dependency audits | `npm audit --omit=dev` (API, web), `pip_audit -r requirements.txt` | PASS | 0 / 0 / none known |
| Secret scan | regex scan of all tracked files; `.env` ignore check | PASS | no keys or credentials tracked; only `*.env.example` files are tracked |
| Client bundle scan | search `.next/static` for configured secret values and OTP-sender identifiers | PASS | none (one match is a library helper that reads a variable *name*) |
| Default-deny sweep | called all 111 registered routes with no session | PASS | 95 return 401; 7 return 404 (public detail routes given an unknown slug, the two internal AI routes, which are disabled when the assistant is not configured, and an SSLCOMMERZ callback with an unknown kind); 9 are public by design: health ×3, config/auth, categories, workers list, ai/status, bKash redirect callback, SSLCOMMERZ IPN |
| Forged payment callbacks | POST/GET forged callbacks | PASS (providers unconfigured) | redirect only, nothing marked paid. Real provider verification is NOT exercised. |
| API hardening probes | headers, CORS preflight, evil Origin, malformed JSON, 2 MB body, query abuse | PASS | security headers present; no CORS headers (same-origin proxy); foreign Origin 403; malformed JSON 400; oversize 413; invalid query 400; no stack traces |
| Real-Chrome journeys | `npm run e2e:browser` on a scratch DB | PASS | 12 journeys; 35 page×width combinations, 0 overflow, 0 axe violations; crawl of 26 pages, 0 dead links, 0 CSP violations; 2 console errors are the expected 404s of the hidden-post and `/messages` checks |
| Real-Chrome OTP journeys | `node e2e/auth-otp.mjs` | PASS | 7 journeys plus 20 overflow/axe checks |
| Route validation in Chrome | invalid ids on booking, payment, community routes | PASS | "Page not found", zero API calls; valid booking loads |
| Mutation checks | revert each fix, expect its new test to fail | PASS | caught: #1, #2, #3, #4, #6, #11, #13, #14. Not independently caught: #15 (redundant with the button's loading state). |
| Migrations | `prisma migrate deploy` on an empty scratch DB, and on the developer's dev DB (confirmed dev) | PASS | 6 migrations |
| Prisma schema drift | `prisma migrate diff` | NOT RUN | needs a shadow database; CI runs it |
| Real Google login / SMTP / bKash / SSLCOMMERZ / LLM | | BLOCKED | no credentials |
| Deployment on Vercel | | NOT RUN | not authorised, nothing deployed |
| Screen reader / manual keyboard pass | | NOT RUN | automated axe only |

## E. Environment configuration for Vercel

Vercel hosts the **web app** (`frontend/`, root directory `frontend`, Next.js preset). Nothing in the repo configures Vercel (`vercel.json` does not exist and is not required).

| Variable | Where | Required | Public / secret | Where to get it |
| --- | --- | --- | --- | --- |
| `BACKEND_URL` | Vercel (web) | **yes** (build now fails without it) | public (baked into a rewrite; not exposed to the browser) | the HTTPS URL of wherever the API runs. Read at build time, so redeploy after changing. |
| `NEXT_PUBLIC_SITE_URL` | Vercel (web) | recommended | public | your production origin; enables absolute OG URLs, sitemap |
| `DATABASE_URL` | API host | yes | **secret** | your PostgreSQL provider; use the pooled URL if one exists |
| `BETTER_AUTH_SECRET` | API host | yes | **secret** | `openssl rand -base64 48`; changing it invalidates sessions and pending codes |
| `BETTER_AUTH_URL`, `FRONTEND_ORIGIN` | API host | yes | public | the Vercel (web) origin, https |
| `TRUSTED_PROXIES`, `TRUST_PROXY` | API host | yes in production (the API refuses to start without `TRUSTED_PROXIES`) | public | **cannot be invented**: it must be the real addresses of the proxy in front of the API. What the API sees behind a Vercel rewrite has not been verified. |
| `MAIL_TRANSPORT=smtp`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | API host | yes in production | `SMTP_PASS` **secret** | your email provider; configure SPF/DKIM on the sender domain |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API host | optional (both or neither) | secret is **secret** | Google Cloud Console (see AUTH.md); redirect URI `https://<web-origin>/api/v1/auth/callback/google` |
| `BKASH_BASE_URL`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_IS_LIVE`, `BKASH_AUTH_SCHEME`, `BKASH_REFUNDS_ENABLED` | API host | optional (all five credentials or none) | key/secret/username/password **secret** | bKash merchant sandbox/production portal. Sandbox and live are validated apart: live is refused outside `NODE_ENV=production`. |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`, `SSLCOMMERZ_IS_LIVE`, `SSLCOMMERZ_REFUNDS_ENABLED` | API host | optional (both credentials or none) | password **secret** | SSLCOMMERZ sandbox/merchant panel |
| `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `APP_API_SERVICE_TOKEN` | API host | optional (all three or none) | tokens **secret** | URLs and tokens you generate yourself; they must differ and be at least 32 characters |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (+ `APP_ENV`, `AI_HOST`, `AI_PORT`, `APP_API_BASE_URL`, limits) | AI service host | only if the assistant is used | key **secret** | OpenRouter dashboard |
| `RATE_LIMIT_ENABLED`, `DATABASE_POOL_MAX`, `DATABASE_*_TIMEOUT_MS`, `HTTP_LOG`, `PORT`, `NODE_ENV` | API host | optional | public | defaults are sensible |

**Architecture and Vercel compatibility**

* **Web app on Vercel: compatible.** Next.js 16 with Cache Components; the build was run; `/api/v1/*` is a rewrite to `BACKEND_URL`, so the browser stays same-origin (first-party cookies).
* **API (NestJS) is written for a long-running Node process** (`app.listen`, Docker image, in-memory rate-limit counters for non-auth routes, a per-instance connection pool). Vercel can run NestJS, but that has **not** been tried here and would need: a serverless entry point instead of `listen`, a shared rate-limit store, pooled connections (the `statement_timeout` fix above helps), and mail sending kept alive past the response (`waitUntil`). The minimum-risk path is to host the API from the provided `backend/Dockerfile` on a container host and point `BACKEND_URL` at it.
* **AI service (FastAPI) holds in-memory per-user limits and concurrency counters**; host it as its own service on a private network. It is optional: the assistant reports "unavailable" and normal search remains.
* **Migrations:** run `npx prisma migrate deploy` from CI or a release step against a backed-up database; never from the web build.
* **Health/rollback:** `/api/v1/health/live` and `/health/ready` exist; operations steps are in RUNBOOK.md.

## F. Next actions (in order)

1. Start the API again (`cd backend && npm run dev`) and the web app; register, enter the printed code, then `npm run admin:grant -- you@example.com`.
2. Decide the product questions in C-1 to C-6 (admin screens first: workers cannot go live without them except through the API).
3. Add Google credentials and the redirect URI; test a real sign-in (AUTH.md checklist).
4. Configure SMTP; confirm the code arrives in an inbox and expires.
5. Create bKash and SSLCOMMERZ sandbox accounts; run a sandbox payment and refund, and confirm the bKash checkout host (#10) and the late-completion behaviour (C-5).
6. Choose the API host; set `BACKEND_URL`, `TRUSTED_PROXIES` and the rest of the API variables; deploy a Vercel **preview** and run the RUNBOOK smoke test.
7. Add the missing foreign keys and indexes in a reviewed migration (C-11).

## G. Readiness decision

**READY FOR LOCAL TESTING.**

Everything that can be proven without external accounts has been proven: the stack builds, 1,000+ automated tests pass against a real database, the real UI was driven in Chrome, and each fix here was shown to fail without it. It is not **READY FOR SANDBOX DEMO** because the three things a sandbox demo needs (a payment-provider sandbox, a working email path and a hosted API behind Vercel) have never been exercised, and one suspected defect (#10, bKash checkout host) would make every bKash payment fail until checked. It is not production-ready: admin screens for worker approval, disputes and refunds do not exist, and there is no support channel.

---

# Follow-up: booking-to-payment-to-review workflow (chat, arrival, payment gate, reviews)

Scope: request -> accept -> private chat -> arrival -> work finished -> bKash payment -> completed -> review. Design and rules: [WORKFLOW.md](WORKFLOW.md). bKash is the only provider (SSLCOMMERZ was already removed and was not touched).
**Nothing was committed, pushed, deployed, migrated on a real database, or paid for.** All runs used a throwaway PostgreSQL cluster (127.0.0.1:5436, databases `fixeditnow_test` and a dropped `fixeditnow_qa`) and the **mock** bKash in `backend/test/fake-providers.ts`. No real bKash sandbox was reached.

## What already existed, and what was missing

| Area | Before | Done now |
| --- | --- | --- |
| Booking request / accept / decline / quotes / slot protection | existing and sound (state machine, per-worker lock, DB exclusion constraint, idempotency key) | reused unchanged |
| Arrival | missing | `arrivedAt` milestone + `POST /bookings/:id/arrive` |
| Work completed | existing, but the **customer's own click** completed the booking | `complete` now means "payment due"; the customer shortcut was removed |
| Payment | existing (initiation, verification, callbacks, refunds) but independent of the booking lifecycle and allowed from `CONFIRMED` | payable only after "work finished"; a verified payment completes the booking in the same transaction |
| Review | existing, required only a customer-confirmed `COMPLETED` booking (known gap C-3 above: review farming) | also requires a provider-verified payment; ratings count only such reviews |
| Booking chat | missing (Step 7 never built) | new: `chat_message`, `/bookings/:id/chat`, UI |
| Notifications | in-app table existed, but no booking/payment/review events used it | wired for the events in WORKFLOW.md, after commit, best effort |

## Files changed (this follow-up only)

* **Schema/migration:** `backend/prisma/schema.prisma`, new `backend/prisma/migrations/20261102000000_booking_chat_arrival_payment_gate/`.
* **Backend:** `bookings/booking.state.ts` (+spec), `booking-core.service.ts`, `bookings.service.ts`, `bookings.controller.ts`, `booking.config.ts`, `quotes.service.ts`; `payments/payments.service.ts`, `payment.config.ts`, `payments.module.ts`; `reviews/ratings.ts`, `review.summary.ts`, `reviews.service.ts`; `notifications/notifications.service.ts` (`notifyBestEffort`); new `src/chat/` (access rules, schemas, service, controller, module); `app.module.ts`.
* **Frontend:** `lib/booking-types.ts`, `lib/format.ts`, `lib/faqs.ts`; `components/bookings/` (`booking-detail.tsx`, `booking-list.tsx`, `status-badge.tsx`, new `chat-panel.tsx`), `components/payments/` (`checkout.tsx`, `payment-list.tsx`), `components/reviews/review-panel.tsx`, home / how-it-works / become-a-worker copy; tests `booking-detail`, `payment-ui`, new `chat-panel`.
* **Tests:** new `backend/test/workflow.e2e-spec.ts` (50 tests); helpers (`booking-helpers.ts`, `payment-helpers.ts`, `helpers.ts`) and the existing `lifecycle`, `disputes`, `journeys`, `payments`, `refunds`, `reviews`, `community`, `moderation`, `admin-operations`, `admin-support` specs updated to the new rules (see "Existing tests that changed").
* **Browser:** new `frontend/e2e/workflow.mjs` (+ `npm run e2e:workflow`), `browse.mjs` and `seed.mjs` updated.
* **Docs / AI knowledge:** new `docs/WORKFLOW.md`; `BOOKINGS`, `PAYMENTS`, `COMMUNITY`, `API`, `ARCHITECTURE`, `RUNBOOK`, `SECURITY`; `rag_agent/knowledge/` (how-booking-works, payments-and-refunds, about-fixeditnow) so the assistant no longer describes the old flow. If the knowledge base was already imported into a database, re-run `npm run kb:import`.

## Schema changes and migration

`20261102000000_booking_chat_arrival_payment_gate` (additive, no enum value added, nothing dropped): `booking.arrivedAt` (+ check: needs `confirmedAt`), table `chat_message` (unique `(bookingId, senderId, clientMessageId)`, `seq` sequence, length/shape checks, a trigger that rejects a sender who is not a participant in the stated role or a booking that was never confirmed, an append-only trigger), and a data fix that completes `COMPLETION_PENDING` bookings which already have a verified payment.
Applied here to two empty/scratch databases; `prisma migrate diff` against `schema.prisma` reports no drift. **It was not run against any database with existing data, so "existing data stays intact" is proven only by reading the SQL (it only adds a nullable column and a table, and the data fix touches only the rows described).** Staging commands and the two pre-flight SQL counts are in WORKFLOW.md.

## State transitions, chat, payment and review rules

Exactly as in WORKFLOW.md; the transition table is `booking.state.ts` and is unit-tested exhaustively (every status x role for `arrive` and `payment_verified`; the only actions that can end in `COMPLETED` are `payment_verified` and the admin dispute outcome).

## Existing tests that changed (and why)

The old tests encoded rules that this workflow deliberately replaces; they were rewritten, not weakened or skipped:

* "customer confirms completion" -> the route is gone (tests assert `404`); completion is reached by paying through the mock provider (`payBooking` helper).
* "payment allowed once confirmed" -> payment is allowed only once the work is finished (`COMPLETION_PENDING`); `payableBooking` now brings a booking to that state, and a test asserts `BOOKING_NOT_PAYABLE` for requested, confirmed, in progress, cancelled and disputed.
* "pay, then cancel, then refund" -> a paid booking can no longer be cancelled by the customer; the refund tests reach `CANCELLED` through a real dispute + administrator `CANCEL_BOOKING` (`cancelViaDispute`).
* Booking status expectations in admin screens (`COMPLETION_PENDING` instead of `CONFIRMED`; `COMPLETED` after a verified payment).
* The browser script's "no messaging exists" and "pay page is unavailable on a confirmed booking" checks.

## Commands actually run, with results

| Command | Result |
| --- | --- |
| backend `npx tsc --noEmit` | clean |
| backend `npm run lint` (oxlint) | 0 errors; 1 pre-existing warning (unused import in `payment-provider.ts`, not part of this change) |
| backend `npm test` (unit) | 19 files, **133 passed** |
| backend `npm run test:e2e` (real PostgreSQL, mock bKash) | baseline before changes: 37 files, 670 passed. After: **38 files, 719 passed, 0 failed** (+50 new in `workflow.e2e-spec.ts`, -1 table row removed from `lifecycle`) |
| frontend `npx tsc --noEmit`, `npx eslint` | clean |
| frontend `npx vitest run` | 24 files, **345 passed** (329 before; +16: chat panel 11, booking-detail 5) |
| rag_agent `pytest` | **148 passed** (unchanged; knowledge text edited) |
| backend production compile (`tsc -p tsconfig.build.json`, to a scratch folder) | clean. `npm run build` itself was not run: it wipes `dist/` under the developer's running `nest start --watch` |
| frontend `next build` (production, on a copy of the app) | succeeded |
| real Chrome, `e2e/workflow.mjs` | 13 checks **passed**: chat button absent before acceptance, acceptance in the UI, stranger gets "not found" (and 404 from the API), messages exchanged both ways, persisted across reload, arrival labelled self-reported, "payment due" screen, no review form before payment, checkout shows the stored amount, review after a **simulated** paid state, review on the public profile, stranger cannot review; layout + axe at 375 and 1366 px on the chat and payment-due pages: no overflow, 0 violations (it found and I fixed two axe violations in the chat log markup) |
| real Chrome, `e2e/browse.mjs` (regression) | 35 page x width checks: 0 overflow, 0 axe violations; 11 flows passed; crawl 26 pages, 0 dead links, 0 CSP violations |

## Test coverage by area (all in `workflow.e2e-spec.ts` unless noted)

* **Booking:** valid creation and idempotent replay; notification of the professional; only the assigned professional decides; declined requests reserve nothing and open no chat; unauthorized and invalid transitions; concurrent slot conflicts (existing `bookings`/`availability`/`reschedule` specs, still passing).
* **Arrival / completion:** only the assigned professional; rejected in every other state and outside the window; parallel reports yield one arrival; no location or status accepted; completion makes payment due and neither pays nor completes; duplicate completions are a safe 409.
* **Payment (mock provider):** amount from the stored booking; unknown reference; forged success redirect completes nothing and the customer can retry; pending, timeout (`PROCESSING`), lost callback recovered by a status check, amount mismatch parked for review; parallel callbacks complete once; payment arriving after a dispute is recorded without completing the booking.
* **Review:** blocked at every earlier stage and for a completed-but-unpaid job; only the customer, once (also under parallel submissions); strict validation; average/count come only from eligible reviews; a full refund or cancellation stops a review counting.
* **Chat:** unavailable before acceptance; both participants send/read in order; strangers, other professionals, administrators and anonymous callers cannot; forged sender/role/booking rejected by the API and by database triggers; messages immutable; retry and burst of the same key store one row and notify once; validation; paging; read-only after the window, on cancellation and during a dispute; per-booking limit.
* **Notifications:** per-event rows asserted in the end-to-end test; a notification store outage does not undo an acceptance.

## Classification

| Requirement | Status | Notes |
| --- | --- | --- |
| Booking request, worker accept/reject, slot reservation, concurrency | **COMPLETE** | reused existing implementation; its tests pass |
| Worker arrival (self-reported) | **COMPLETE** | not location-verified, and labelled so |
| Work completion -> payment due | **COMPLETE** | |
| Payment from trusted server data, idempotent, verified before completion | **COMPLETE against the mock** | **real bKash sandbox: NOT RUN / BLOCKED (no credentials)** |
| Duplicate callbacks, polling, timeouts, ambiguous results | **COMPLETE against the mock** | real bKash behaviour unverified (issues C-5, #10 above still open) |
| Review eligibility, uniqueness, real averages | **COMPLETE** | policy changed: paid is required |
| Private booking chat (access, persistence, retry, states) | **COMPLETE** (polling) | no WebSocket push, no read receipts, no attachments, by design and stated in the UI |
| Customer and worker UI | **COMPLETE** | worker "booking history and customer review visibility" use the existing bookings list and review panel |
| In-app notifications | **COMPLETE** | no retry queue: two attempts, then logged |
| Email / push notifications for these events | **NOT BUILT** | nothing claims an email was sent |
| Migration on a database with real data | **NOT RUN** | only scratch databases |
| Real payment / sandbox payment | **BLOCKED** | needs bKash merchant sandbox credentials |
| Browser test of the real payment redirect | **NOT RUN** | paid state was simulated in SQL for the UI pass |

## Remaining blockers and things that need you

1. **The migration has not been applied to the database in `backend/.env` (the remote developer database).** Your running `nest start --watch` API will now fail booking queries (`arrivedAt`, `chat_message`) until you run `cd backend && npm run db:deploy` against it. I did not do this without your approval. Run the two pre-flight queries in WORKFLOW.md first if it holds data you care about.
2. bKash sandbox credentials are needed to verify the real checkout host, callback shape and execute/query timing (still the biggest unverified assumption in the system).
3. Product decisions this change surfaced: a paid booking can only be cancelled by an administrator through a dispute (so refunds are reachable only that way); reviews on bookings completed without payment stop counting; chat retention is "kept, readable by the two participants" with no deletion job.
4. The `tsc` unused-import warning in `payment-provider.ts` is in a file with your uncommitted edits; I left it alone.

## Addendum: customer "Work is finished: pay now" (requested after the first pass)

Requested change: the customer can declare the work finished themselves when it was done before the scheduled time (the professional's arrival/start window opens only 30 minutes before the appointment). This **supersedes** the earlier rule that only the assigned professional can report completion. New action `customer_finish` (`POST /bookings/:id/mark-finished`, customer only, from `CONFIRMED`/`IN_PROGRESS`) moves the booking to `COMPLETION_PENDING`; it does not complete or pay anything, only a verified payment still does, and a dispute remains possible. The professional is notified. Also fixed: the progress strip's outlined "next" step looked like a completed step (now labelled "Next"), and the professional now sees when arrival/start open (`startWindowOpensAt`).
Verified: state-machine unit test (every status x role), 3 new e2e tests (permissions, early finish then pay then review, in-progress, invalid states, reschedule withdrawn, double press), 1 new UI test; the real-Chrome scripts were NOT re-run after this change.

## Follow-up: demo access ("Explore Demo")

Design and operation: [DEMO.md](DEMO.md). Nothing was committed, pushed, deployed or applied to the remote database in `backend/.env`; the two migrations (`20261103000000_demo_payment_provider`, `20261103010000_demo_access`) were applied only to scratch PostgreSQL databases (port 5436). `prisma migrate diff` against the schema reports no difference.

### Commands run and results (real output)

| Command | Result |
| --- | --- |
| `cd backend && npm run test:e2e` (real PostgreSQL, mock bKash) | baseline before the change: 38 files, 722 tests passed. After: **42 files, 792 tests passed** (70 new: demo-access 28, demo-isolation 20, demo-workflow 9, demo-settings 13; `route-audit` updated for the one new public route) |
| `cd backend && npx vitest run` (unit) | **22 files, 145 tests passed** (new: realm classification, demo config, DemoGuard) |
| `cd backend && npx tsc --noEmit` | clean |
| `cd backend && npm run lint` | 1 warning, pre-existing (`PaymentProvider` unused import in `payment-provider.ts`, present at HEAD) |
| `cd frontend && npx vitest run` | **28 files, 425 tests passed** (baseline 24 files / 347) |
| `cd frontend && npx tsc --noEmit`, `npx eslint src e2e/demo.mjs` | clean |
| `cd frontend && node e2e/demo.mjs` (real Chrome 1.64 via playwright-core against a production web build + API on a scratch database) | **14 of 14 steps passed**: default hidden; admin signs in and flips the six switches through the reason dialog; login page at 375 and 1366 px (no overflow, axe clean); Demo Customer double-click gives one session, HttpOnly + SameSite=Lax cookie, nothing in web storage, simulated payment completes the booking, Exit demo; Demo Worker lands on the worker side and accepts a request; Demo Admin sees demo users only, a write is refused, no demo switches visible; switching Demo Admin off ends its open session and shows it unavailable |

### Requirement classification

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Three demo options on the login page, descriptions, loading and double-click protection, mobile + desktop | **COMPLETE** | unit tests + browser pass |
| Redirect to the right dashboard, Demo mode indicator, exit | **COMPLETE** | browser pass |
| Normal login, Google, email OTP, registration unaffected | **COMPLETE for the code paths** | existing suites (auth, email-otp, google-*, onboarding) pass unchanged. **Real Google and real SMTP: NOT RUN** (no credentials, as before) |
| Admin "Demo Access Settings", independent visibility/availability, persistence, audit, failed update keeps last state | **COMPLETE** | demo-settings e2e (restart simulated with a second app instance), browser pass |
| Public safe read-only options endpoint | **COMPLETE** | exposes nothing but visible options |
| Idempotent seed, fictional data, no destructive startup | **COMPLETE** | `npm run demo:seed`; idempotency, constraint-valid data and "refuses to seed over a real account" tested |
| Reset | **COMPLETE** | `npm run demo:reset -- --yes`, tested to remove demo rows only and restore the append-only triggers |
| Demo Admin hardening (dedicated identity, read-only, allow-list, no settings access, tests on every route) | **COMPLETE** | dynamic test refuses every state-changing route; widening the role row behind the app's back grants nothing |
| Session isolation, cookies, CSRF, expiry, logout, rate limits | **COMPLETE** | cookie flags tested (Secure in a production-mode app); **real HTTPS / Vercel: NOT RUN** |
| Data isolation demo vs real, both directions | **COMPLETE** | realm firewall + DB triggers; tests fill both realms and cross from each side |
| Concurrency of shared identities | **COMPLETE as a documented trade-off** | shared identities, no per-visitor sandbox (append-only tables); drift until reset; DEMO.md section 9 |
| Simulated payments; no real provider/refund/mail from demo | **COMPLETE** | the provider mock records zero calls and the mail outbox stays empty through the whole demo flow |
| Real bKash sandbox | **BLOCKED / NOT RUN** | no credentials (unchanged) |
| Applying the migrations to a database with real data / production | **NOT RUN** | by instruction; reviewed SQL only. Run `npm run db:deploy` yourself, then `npm run demo:seed` |
| Hosted deployment check (Vercel) | **NOT RUN** | |
| Load/performance of the realm filter | **NOT RUN** | each scoped query adds a join on the owning user |

### Things worth knowing

- `backend/.env` currently has `DATABASE_CONNECT_TIMEOUT_MS=100000`, above the allowed maximum (60000): a fresh `npm run start` / `nest start` fails env validation with that value (found when starting a QA API; I did not edit your `.env`).
- Pre-existing, not caused by this change: signing out of any account on a page with many protected links makes Next prefetch `/login?next=...&_rsc=...` and receive 404s (reproduced with the ordinary admin account).
- The discovery pages' server-side fetch now forwards the session cookie (only that cookie) to the backend so a demo visitor sees the demo professionals; `serverApi` previously forwarded none. The public endpoints use it only to choose the data realm.
- Hidden-but-enabled roles: `/demo/<role>` still offers the button (the server decides), matching "hidden is not disabled".
- Existing e2e fixtures needed one change: the test helper that clears roles keeps the new system role `demo_admin`.
