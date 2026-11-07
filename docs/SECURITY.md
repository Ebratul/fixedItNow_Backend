# Security (as implemented in Step 3)

Scope: authentication, sessions, authorization, onboarding, discovery, bookings and payments. Messaging,
file upload, AI, and admin UI are later steps and are **not** covered.

## Controls

| Area | What is in place |
| --- | --- |
| Credentials | Better Auth hashes passwords with **scrypt**; only the hash is stored. Min 10, max 128 chars. No custom crypto in this repo. |
| Sessions | Server-side sessions in PostgreSQL. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` + `__Secure-` prefix in production (test-verified). No token in localStorage or any JS-readable storage. 7-day expiry, refreshed daily. Cookie cache **disabled**, so revocation is immediate. New random token on every login (no fixation). |
| Authentication vs authorization | `AuthGuard` (global, **default deny**) only establishes identity. `AdminGuard`, `ApprovedWorkerGuard`, and pure functions in `backend/src/auth/policies.ts` decide permissions. Role is read from the database on every request. |
| Admin creation | Only `npm run admin:grant -- <email>` (needs DB access, verified user, writes audit log). No API, form field, query param, or request body can set a role (tested). |
| IDOR | "Me" endpoints take no id and always act on the session user. Strict Zod schemas **reject** unknown keys (`userId`, `id`, `role`, `verificationStatus`...) instead of ignoring them. |
| Worker verification | `onboardingStatus` and `verificationStatus` are separate. Workers can only submit (`PENDING`). Only an admin review sets `VERIFIED`/`REJECTED`/`RESUBMISSION_REQUIRED`; reviewers cannot review themselves; each decision is audit-logged. |
| Account enumeration | Sign-up, sign-in, resend, and password-reset give identical responses for known and unknown emails (tested). The real owner receives a notice email on duplicate sign-up. |
| Email verification | Required before any session exists. Provider-generated signed, 1-hour tokens; reset tokens are single-use and revoke all sessions. |
| CSRF / origin | Better Auth origin check is **explicitly enabled** (it is silently off under `NODE_ENV=test` otherwise). App routes additionally require `Origin`/`Referer` = web origin for unsafe methods. `SameSite=Lax` cookies. No CORS is enabled (same-origin via proxy). |
| Open redirects | `callbackURL`, `redirectTo`, `errorCallbackURL` validated against trusted origins by Better Auth (tested: absolute, `//host`, `/\host`). The web app's `?next=` goes through `safeNext()` (unit-tested). |
| OAuth (Google) | Authorization-code flow with `state` and PKCE (S256), identity scopes only, secret server-side only. **Implicit account linking is disabled** (see below). |
| Rate limiting | Better Auth limits on auth endpoints; `@nestjs/throttler` (120/min/IP) on the rest. Production uses DB-backed storage for auth limits. |
| Input validation | Zod on every request body/query on the server; the web app validates too but is not trusted. |
| Logging | Mail failures log kind + error only, never recipient or link. Passwords/tokens are never logged. **Dev console mail transport prints links (with tokens) and is refused in production.** |
| Headers | `helmet` on the API; baseline headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) on the web app. |
| Secrets | `.env` is git-ignored; examples contain placeholders only. Env validation fails fast on weak/missing secrets and unsafe production settings. |

## Discovery and privacy (Step 4)

| Area | What is in place |
| --- | --- |
| Visibility | One shared filter (`ELIGIBLE_WORKER`) is spread into every public query; hidden, unpublished, suspended, draft and unknown profiles return an identical `404`. Search terms and filters cannot widen it (tested). |
| Private data | Public responses use explicit `select`s: no email, user id, review note, suspension reason, or verification data (tested by scanning serialized responses). Profile identifiers are slugs (`name-8hex`), not user ids or emails. |
| Search safety | Prisma query API only (no raw SQL). `sort` is a closed enum; numeric/enum filters are bounded; unknown params ignored. `%`, `_`, `\` are escaped so they match literally. Injection-looking input returns normal empty results (tested). |
| Ownership | Owner publish/unpublish act on the session's profile; the edit schema rejects `slug`, `publishedAt`, `suspendedAt`, `startingPriceBdt`, `verificationStatus`, `id`, `userId`. Only admins can suspend; an admin cannot moderate themselves; reasons stay internal. |
| Favorites | Session-only identity; unique constraint prevents duplicates under concurrency (tested with parallel requests); lists are private; own-profile and non-public targets rejected. The browser cache of favorite ids is cleared when the signed-in user changes. |
| Rendering | Worker text is rendered as React text (escaped); there are no user-provided links, HTML or images. A `<script>`/`<img onerror>` payload renders inert (tested). |
| Rate limiting | `GET /workers` is limited to 60/min/IP on top of the global 120/min. |
| Categories | No write endpoints exist; unauthenticated, ordinary-user and admin write attempts change nothing (tested). |

Findings in Step 4:
1. Prisma's `contains` does **not** escape `%`/`_`, so `q=%` matched every profile. Fixed with `escapeLike()` and a test.
2. `startingPriceBdt` had to be backfilled for existing rows; done additively in the migration.
3. `/workers/[slug]` and `/services/[slug]` unknown pages are soft-404s (see ARCHITECTURE).

Known limitations (Step 4): edits to a **published** profile go live immediately without re-review (moderation
is suspend-after-the-fact); no profile photos (initials avatar only, no upload endpoint); `VERIFIED` still
means "admin reviewed the profile", not an identity check.

## Bookings, availability and disputes (Step 5)

| Risk | Control |
| --- | --- |
| IDOR / BOLA | Every booking route loads the booking and checks the caller is its **customer or assigned worker**; strangers, other workers, admins (outside disputes) and unknown ids all get the same `404`. Quote and reschedule ids are always looked up *within* the booking in the URL. Tested for each endpoint family. |
| Role confusion | Role-specific actions check the viewer role (`403 NOT_ALLOWED`) and the state machine's role table (`409`); the UI only renders what `actions` allows. |
| Mass assignment | Strict Zod schemas on every body: `status`, `customerId`, prices, totals, `isAdmin`, evidence fields -> `400`. No endpoint takes a status. |
| Price tampering | Prices come from the worker's stored service (snapshotted) or the stored quote; the quote total is computed server-side and also CHECK-constrained; `expectedTotalBdt` can only make a request *fail*. |
| Races / double booking | Worker row lock + conditional updates + DB exclusion constraint; tested with parallel accepts, quote accepts, reschedules and a raw-SQL attempt. |
| Duplicate submissions | `Idempotency-Key` replay, advisory lock + overlap check, 20 open-request cap, 10/min creation throttle. |
| State abuse | Illegal transitions -> `409 INVALID_TRANSITION`; double cancel yields one event; a disputed booking can only be changed by the dispute workflow. |
| Privacy | Street address hidden from the worker until confirmation; no emails/ids in any booking payload (tested); internal dispute notes never returned to participants; admin dispute view has names but no emails. |
| Admin | `RequireAdmin` (role read from DB every request); admin actions are audit-logged; an admin cannot moderate a dispute they are party to; no admin booking list outside disputes. |
| Injection / XSS | Prisma API (the only raw SQL are parameterised lock/advisory-lock statements with no user text); descriptions and messages stored verbatim and rendered as React text (tested); 100 KB body limit (`413`). |
| Abuse | Per-route throttles (bookings 10/min, disputes 5/min, cancel/quote/reschedule/messages 20/min). |

Findings in Step 5: Prisma cannot deserialise `pg_advisory_xact_lock`'s `void` result via `$queryRaw` (fixed with `$executeRaw`); the first draft of a
test suite showed that a new request for an already-confirmed slot is (correctly) refused up front, so competing requests must be created *before* the first
confirmation; a newly published `multer` advisory (transitive dependency of NestJS, unused because there are no uploads) was fixed with an `overrides` pin.

Known limitations (Step 5): disputes are text-only (no evidence upload); no refund/payout outcomes; no notifications; expiry is lazy (no scheduler); a
reviewer cannot yet see a general booking list; cancellation has no fee/refund policy (a product decision); customer-written text is not moderated.

## Payments (Step 6)

Full design: [PAYMENTS.md](PAYMENTS.md).

| Risk | Control |
| --- | --- |
| Fake success (redirect, query string, forged callback/IPN) | Callback routes never read a status as truth. A payment becomes `SUCCEEDED` only inside `PaymentsService.applyVerification` from a provider server-to-server answer (bKash execute+query; SSLCOMMERZ Order Validation API). Tested: a success callback for an unpaid payment fails or stays `PROCESSING`. |
| Reference / transaction substitution | The attempt is found by our unguessable reference (96 random bits); the provider's reported reference, payment id, amount and currency must all match; a `val_id` that validates to another `tran_id` is discarded; a provider transaction id already attached to another attempt cannot settle a second one. Mismatches are quarantined (`REQUIRES_REVIEW`), never attached silently. |
| Amount / currency tampering | The amount is `booking.agreedAmountBdt` read in the server (strict body: only `provider`); compared as integer poisha; `BDT` only (CHECK). |
| BOLA / IDOR | Initiation, status, history and refund requests load by owner; other users, the professional and admins-on-the-customer-routes get the same `404`. Admin routes use `RequireAdmin` and exclude bookings the admin takes part in. |
| Replay / duplicates | `payment_event.dedupeKey`, conditional updates, "already settled" short-circuit, one execute per bKash payment (DB claim), `Idempotency-Key`, unique open-attempt / paid-per-booking / open-refund indexes. |
| Race conditions | Booking-then-payment row locks in one transaction for every verification; the database refuses a second paid payment or open attempt even if code is wrong. Tested with parallel initiations, parallel callbacks and parallel refund requests/processing. |
| Late callbacks | No state-machine edge leaves `SUCCEEDED` except to a refund state; a late success after cancellation is recorded as paid-but-ineligible and does **not** reactivate the booking. |
| Ambiguity | Timeouts/5xx/auth errors never mean "failed": the attempt stays `PROCESSING`/`INITIATED` and is re-queried. Only provider-initiation failure (no URL issued) closes an attempt on a timeout. A refund timeout is never re-sent. |
| CSRF vs. provider callbacks | The Origin check stays on every route. Only the callback controller opts out via `@SkipOriginCheck()` (cross-site by nature; no cookies used); a unit test fails if the decorator appears anywhere else. |
| Open redirect | Return/callback URLs are built from configuration and the stored reference. No redirect target comes from the request. The checkout URL returned to the browser must be `https` on `.bka.sh` / `.sslcommerz.com`, and the frontend re-checks `https:` before navigating. |
| Secrets | Read from the environment only; never returned (tested by scanning API bodies and stored events for the test secrets); the HTTP client's errors carry no URL/headers/body because some provider calls put the store password in the query string; bKash token in memory only. Startup refuses live credentials outside production and sandbox/live mix-ups. |
| Logging | Callback errors log only an error name. No payload, URL, token or credential is logged. |
| Audit | `payment_event` is append-only (trigger rejects UPDATE/DELETE; tested). Admin reconcile/refund actions also write `audit_log`. Customers and workers have no write path. |
| Privacy | The professional sees only whether a verified payment exists. Customer name and email go to the provider as the provider requires (SSLCOMMERZ `cus_name`, `cus_email`). |
| Abuse | Initiation 10/min, refund request 5/min, admin reconcile 10/min (batch 2/min), callbacks 60/min per IP, 10 attempts per booking per hour. |

Known limitations (Step 6): nothing was verified against the real providers; the bKash callback `signature` and the SSLCOMMERZ IPN `verify_sign` are not checked
(algorithms unspecified in the pages read; verification is server-to-server instead); a forged `cancel`/`failure` callback needs the unguessable reference but, if it
arrived, would close the attempt (a later provider-verified payment still upgrades it); no scheduler for reconciliation; callback rate limits are per instance;
no admin UI; personal data minimisation toward providers has not had a legal review.

## AI assistant (Step 8)

Full model: [AI.md](AI.md). Controls:
- **Model output is untrusted data.** It is parsed, validated against closed types, and each field is sanitised; invalid or unknown values are discarded. The model never chooses tools, arguments or worker ids.
- **Grounding in two layers:** the AI service re-checks every card the search returns against the user's filters; the main API then re-reads every recommended id from PostgreSQL under `ELIGIBLE_WORKER` plus the stated filters and drops the rest. Unknown fields in the AI response are a `502`; source links must be site-relative.
- **Least privilege:** the AI service has no database credentials; its only tools are two read-only endpoints behind `ServiceTokenGuard` (constant-time bearer comparison, fails closed, `404` when unconfigured). Two different secrets (one per direction), both required to be >= 32 characters.
- **Refusals happen in code, before any model or tool call:** another person's contact details or bookings, system prompt / keys, SQL or shell. A request to book/cancel/pay yields a note, never an action; model text that claims an action is rejected.
- **Privacy:** the model sees only the current message, the chosen filters and the public category list. Nothing is persisted; logs hold metadata only (a test asserts message text, user id and secrets are absent). The AI service receives a hash of the user id.
- **Abuse/cost:** login required; per-user, per-IP and per-subject limits; concurrency cap; bounded model calls (<= 2 per step) and search calls (<= 4).
- **Findings during implementation:** (1) the first service-auth check accepted a bare token without the `Bearer` scheme, caught by a test; (2) the first retrieval threshold returned an unrelated passage for "weather in Dhaka", caught by a test and tightened; both now have regression tests, and deliberately breaking each security-critical line (token check, id re-validation, strict response schema, link allow-list, per-user limit, eligibility filter) makes a test fail.
- **Not verified:** nothing was run against real OpenRouter or a real model, so real-model injection resistance is unmeasured. The structural defenses above do not depend on the model's behaviour; the offline evaluation includes a model that *obeys* an injection.

## Reviews, community and moderation (Step 9)

Full model and policies: [COMMUNITY.md](COMMUNITY.md). Controls (each has a test):
- **Review integrity:** eligibility (customer of a `COMPLETED` booking with a provider-verified payment) is decided server-side from the database; `UNIQUE (bookingId)` stops duplicates under parallel requests; bodies are strict, so `customerId`, `workerProfileId`, `status`, "verified", moderation fields are rejected; "Verified booking" is derived from a join, never a flag; hidden reviews cannot be edited or withdrawn; edits keep the previous text; only the author can edit/withdraw (others get the same `404` as a missing review).
- **Access control / IDOR:** content ownership is checked in the `WHERE` of every write (`authorId = session user`); another user's post/comment/review is `404`; hidden/deleted content is `404` to everyone but the author (who sees a "removed" state); all admin routes use `RequireAdmin` (role re-read from the database on each request). Role/`isAdmin` in a body, query string or header does nothing (tested). Registration and onboarding cannot grant admin.
- **Conflict of interest:** an administrator cannot moderate their own content, decide a report they filed, or decide their own proposal.
- **Duplicates and races:** reactions and votes use `ON CONFLICT DO NOTHING` on unique indexes (parallel requests tested); one report per user per item; report decisions and proposal decisions are conditional updates (two moderators: one wins).
- **Abuse limits:** per-IP throttles, plus per-user rolling caps from the database (10 posts/hour, 30 comments/hour, 3 proposals/day, 20 reports/day).
- **XSS:** all content is plain text, stored verbatim and returned as JSON (`nosniff`); the UI renders text nodes only; control and bidi-override characters are rejected. Tests store `<script>`/`<img onerror>` payloads and assert they are returned as inert strings and rendered as text.
- **Reporter and author privacy:** a report response is `{id, status, createdAt}`; content authors never learn who reported; admin views show public display names only, no emails or account ids (asserted by scanning responses); the moderation history shows only moderation actions.
- **Audit:** every privileged action writes `audit_log` (actor from the session, target, from/to, reason) in the same transaction; a forced audit failure rolls the change back. Reasons are staff-written, bounded to 500 characters; secrets, tokens, emails and identity data are never written.
- **Proposals:** a vote threshold only lists a proposal for admin review; it changes no status, deploys nothing, activates no category. Votes freeze once a decision is made.
- **AI:** no AI processes review or community text (sentiment analysis was deliberately not built; see COMMUNITY.md), and the Step 8 assistant's knowledge base is curated files, so user content cannot become instructions.
- **Finding during implementation:** the first admin queue response included the content author's internal account id; found by a response-scan test and removed.
- **Not done:** CAPTCHA, spam/profanity filtering, per-user read limits, a separate moderator role, moderation notifications, shared-store rate limits for multi-instance deployments.

## Step 10 audit (final hardening)

Findings, severities, evidence and the launch blockers: [AUDIT.md](AUDIT.md). Controls added or verified in this step:
- **Default deny is now a test**: `test/route-audit.e2e-spec.ts` walks the live router and requires `401` for every route outside a reviewed public list; admin/service routes refuse an ordinary session; no CORS allowance is granted; security headers present. Making a controller public by mistake fails it.
- **Audit log is append-only at the database** (migration `20261028000000_step10_audit_log_integrity`): UPDATE/DELETE are rejected except the foreign key's detach-actor on user deletion. TRUNCATE is not intercepted: give the application a DML-only database role.
- **Safe error handling and logging:** unexpected errors return a generic 500 with a request id; the server logs only the error class, code and five stack frames (never the message, which can embed query data); body-parser 4xx errors keep their status with fixed text. One JSON access-log line per request records the route template, never query strings (provider callbacks carry tokens there), bodies, cookies or ids.
- **Web hardening:** Content-Security-Policy (same-origin only; `frame-ancestors 'none'`, `object-src 'none'`), `Cross-Origin-Opener-Policy`, HSTS in production. `script-src 'unsafe-inline'` remains because Next's bootstrap scripts need it without a per-request nonce; acceptable because user content is only ever rendered as text.
- **Resource limits:** explicit database pool size, connect timeout and statement timeout; bounded SMTP timeouts.
- **Secrets:** gitleaks over the whole history and tree found nothing real; `npm audit` (both apps) and `pip-audit` report no vulnerabilities.
- **Booking chat:** participants only (everyone else, including administrators who are not a party, gets the booking's 404); sender, role and booking come from the session and the URL, never the body (strict schema); a database trigger rejects a message from a non-participant, in the wrong role, or on a booking that was never confirmed; a second trigger makes `chat_message` append-only; text is plain, validated like other user text, never copied into notifications; no endpoint exposes messages publicly or to admin views.
- **Honest UI:** stale copy claiming features were unavailable (or available, for messaging) was corrected.
- **Still open:** no real-provider verification (payments, OAuth, SMTP, OpenRouter), no messaging/notifications, no scheduler, per-process rate-limit counters, no Terms/Privacy, no account deletion, no third-party penetration test.

## Account-linking policy

Google sign-in **never** auto-merges into an existing account because the email
matches (`disableImplicitLinking: true`, no trusted providers). This blocks
pre-hijacking: an attacker registering a victim's email with a password they
control and waiting for the victim to sign in with Google. A user who has both
must log in with their password and press "Connect Google" on `/account`.
Consequence: someone who registered with a password and later clicks "Continue
with Google" gets a clear `account_not_linked` message instead of silent merging.

## Findings during implementation

1. **Better Auth disables origin/redirect validation when `NODE_ENV=test`** by default. Tests initially "passed" an open redirect. Fixed by setting `advanced.disableOriginCheck=false` explicitly and asserting it in tests.
2. **Next.js rewrites do not set `X-Forwarded-For` and pass client-supplied values through.** Behind the rewrite alone, Better Auth cannot identify clients (rate limiting would be skipped or spoofable). Mitigation: production **requires** `TRUSTED_PROXIES` and a real reverse proxy that sets the header; rotation-spoofing is covered by a test. See `docs/DEPLOYMENT.md`.
3. `sendOnSignIn` produced verification links landing on `/`. Superseded: email verification is now a one-time code (see [AUTH.md](AUTH.md)); codes are HMAC-hashed at rest, expire in 10 min, allow 5 guesses, are single-use, and verification also requires the account password so a pre-registered address cannot be hijacked with the owner's code.
4. Starter template pulled in `@nestjs/mau` with high-severity advisories; removed (unused).

## Not done / known limitations

- **Google OAuth is not verified end to end** (no credentials). Config, state, PKCE, redirect URI, error handling and linking policy are tested against a stubbed token endpoint; a real token exchange is not.
- **OTP email delivery is not verified end to end** (console sink only). Whether a Vercel rewrite forwards the real client IP is unverified; the per-address OTP limits do not depend on it.
- **SMTP verified only against a local sink**, not a real provider; deliverability (SPF/DKIM) is untested.
- Identity-document upload/verification does not exist, so `VERIFIED` means "admin reviewed the profile", not "identity checked". The UI says so; no public listing or badge exists yet.
- No Terms/Privacy pages or acceptance checkbox (no approved legal text). Needed before launch.
- No CAPTCHA, no 2FA, no breached-password check, no account lockout beyond rate limits, no email-change or account-deletion flow.
- No Content-Security-Policy on the web app (needs a nonce-based policy).
- Rate-limit counters for non-auth routes are in-memory (per instance); use Redis when running more than one instance.
- Admin has no UI yet (API + operator script only).
- AI assistant: not tested with a real model/provider; rate-limit counters are per process; `/api/v1/internal/ai/*` is token-protected but should also be blocked at the proxy; no CSP yet (see above).
- Dependency/vulnerability scanning is a manual `npm audit` (0 vulnerabilities at the time of writing); no CI yet.


## Admin panel (see [ADMIN.md](ADMIN.md))

* **Authorisation:** `@RequirePermission` on every `/admin/*` route (a test enumerates the real controllers and fails on a route without one, or a permission no route uses). Permissions are read from the database per request. ADMIN without a role = no permissions. Escalation rules, self-action bans and the last-super-admin trigger are described in ADMIN.md.
* **Identity documents:** encrypted at rest (AES-256-GCM, row-bound AAD), no public or owner read path, audited per view, `no-store` + sandboxed responses, magic-byte validation, size cap, rate limit. Not covered: retention/auto-deletion, malware scanning, EXIF stripping, key rotation tooling.
* **Audit:** append-only trigger + SHA-256 hash chain verified inside PostgreSQL; metadata sanitiser; the residual risk (superuser rebuilding the chain, TRUNCATE, deleting the newest rows) needs an external head-hash anchor and restricted database roles.
* **Confirmation:** money-moving, access-removing and publishing actions require `confirm: true` server-side in addition to the UI dialog.
* **Maintenance mode** never blocks payment-provider callbacks (money in flight must land) or administrators.

## Demo access (see [DEMO.md](DEMO.md))

Threat: a public, credential-free login (including a privileged admin identity) next to real users' data and real money.
Controls: (1) the login endpoint accepts only a role *name* from three, maps it server-side to a fixed user, checks the administrator's `enabled` switch on every call and on every later request, checks Origin (login CSRF), is rate limited per IP and capped per role; (2) the realm firewall in `PrismaService` plus database triggers keep demo and real data apart in both directions; (3) the Demo Admin is read-only on every route and its permissions are intersected with a code allow-list; (4) demo sessions cannot use account routes (credentials, linking, session list/revoke), the AI model or document uploads; (5) payments use a simulated provider that cannot reach bKash, enforced in code and in the database; (6) demo addresses are reserved `.invalid` names and mail to them is suppressed; (7) settings changes and the sessions they end are audited. Residual risks (shared identities, drift, per-process write budget, unverified production cookie/IP behaviour) are listed in DEMO.md section 9 and 12.
