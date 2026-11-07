# API reference (as implemented)

Base path `/api/v1`. The browser reaches it through the web app's origin
(Next.js rewrites `/api/v1/*` to the backend), so cookies are first-party.
JSON in, JSON out. Errors use Nest's shape: `{ statusCode, error, message }`;
validation errors add `errors: [{ path, message }]`.

**Authentication** is a session cookie (`better-auth.session_token`, or
`__Secure-better-auth.session_token` in production). Every route requires a
valid session **unless marked Public**. **State-changing requests (POST/PUT/PATCH/DELETE)
must carry an `Origin` (or `Referer`) equal to the web app's origin**, otherwise `403`.

## Authentication (Better Auth, mounted at `/api/v1/auth/*`)

Full list: Better Auth docs. The ones the web app uses:

| Method & path | Purpose | Notes |
| --- | --- | --- |
| `POST /auth/sign-up/email` | Register `{ name, email, password }` | Same `200` response whether or not the email exists; no session until verified. Password 10-128 chars. A 6-digit code is emailed. |
| `POST /auth/email-otp/verify-email` | Verify `{ email, otp, password }` | Success marks the email verified and starts a session. `password` is required (account-takeover guard). Wrong/expired/used code -> `400 INVALID_OTP` / `OTP_EXPIRED`; after 5 wrong guesses -> `TOO_MANY_ATTEMPTS`. 15 per 10 min per IP. |
| `POST /auth/email-otp/send-verification-otp` | Send/resend `{ email, type: "email-verification" }` | Always `{ "success": true }`: unknown address, verified address, 60 s cooldown and 5/hour cap send nothing and say nothing. Other `type`s -> 400. 6 per 10 min per IP. |

The link routes `/auth/verify-email` and `/auth/send-verification-email`, and the code routes for sign-in, password reset, email change and
`check-verification-otp`, are disabled (404). See [AUTH.md](AUTH.md).

| `POST /auth/sign-in/email` | Log in `{ email, password }` | `401` for wrong password **and** unknown email (identical); `403 EMAIL_NOT_VERIFIED` only after a correct password. |
| `POST /auth/sign-in/social` | Start Google `{ provider: "google", callbackURL, ... }` | Returns Google URL (state + PKCE). Fails when Google is not configured. |
| `GET /auth/callback/google` | OAuth callback | Validates state; on failure redirects to the error URL with `?error=`. |
| `POST /auth/request-password-reset` | `{ email, redirectTo }` | Same answer for unknown emails. |
| `GET /auth/reset-password/:token?callbackURL` | Validates token, redirects with `?token=` | Invalid -> `?error=INVALID_TOKEN`. |
| `POST /auth/reset-password` | `{ newPassword, token }` | Revokes all sessions. Token is single-use. |
| `GET /auth/get-session` | Current session | |
| `POST /auth/sign-out` | End the **current** session | Other devices stay signed in. |
| `POST /auth/revoke-other-sessions` | End all other sessions | |
| `GET /auth/list-accounts`, `POST /auth/link-social` | Sign-in methods; explicitly link Google | Signed-in users only. |

Rate limits (per client IP): sign-in 5/min, sign-up 5/min, reset request 3/5 min,
reset 5/min, resend verification 3/5 min, everything else 100/min. `429` with `X-Retry-After`.

## Application endpoints

| Method & path | Access | Description |
| --- | --- | --- |
| `GET /health` | Public | `{ status: "ok" }`; `503` if the database is down. |
| `GET /config/auth` | Public | `{ googleEnabled, emailVerificationRequired, minPasswordLength }`. |
| `GET /categories` | Public | Active categories `{ slug, name, description, workerCount }`. `workerCount` is **computed** from publicly listed workers. |
| `GET /categories/:slug` | Public | One active category (same shape under `category`). `404` for unknown, malformed, or inactive slugs. |
| `GET /me` | Session | Caller's own account summary: `user`, `isAdmin`, `customer`, `worker`. |
| `PUT /me/customer-profile` | Session | Upsert own customer profile `{ displayName, preferredDivision? }`. |
| `PUT /me/worker-profile` | Session | Save a draft (any subset): `displayName, headline, bio, experienceYears, languages, serviceAreas, services[], onboardingStep`. **Strict**: unknown keys (e.g. `verificationStatus`, `userId`, `role`) -> `400`. |
| `POST /me/worker-profile/submit` | Session | Validates completeness, sets `onboardingStatus=SUBMITTED`, `verificationStatus=PENDING`. `409` if not submittable. Does **not** approve. |
| `GET /worker/workspace` | Approved worker | Requires `SUBMITTED` + `VERIFIED`. Foundation for worker-only features. |
| `GET /admin/workers?status=PENDING&page=1` | Admin | Review queue (includes email). |
| `POST /admin/workers/:id/verification` | Admin | `{ decision: VERIFIED\|REJECTED\|RESUBMISSION_REQUIRED, note? }`. Note required unless `VERIFIED`. Only `PENDING` profiles; reviewer cannot review themselves; writes an audit-log row. |

"Me" endpoints take **no user id**: the subject is always the session's user.

## Status codes you will see

`400` validation, `401` no/invalid session, `403` forbidden / cross-origin / unverified email,
`404` unknown id, `409` wrong state (e.g. already submitted), `429` throttled, `5xx` server.
Error bodies never include stack traces, SQL, or submitted values.

## Discovery (Step 4)

### Public listing rules
A worker appears in **any** public read only if all hold: onboarding `SUBMITTED`, verification `VERIFIED`
(admin-approved), the owner **published** it, an admin has **not suspended** it, and it has a slug.
This is a single shared filter (`ELIGIBLE_WORKER`) used by search, profile, category counts and favorites.

### `GET /workers` (Public)
Search the directory. Throttled to 60 requests/min/IP. **Never** returns per-viewer data (no favorite flags).

| Query param | Rule |
| --- | --- |
| `q` | Free text, trimmed, <= 80 chars. Blank = ignored. Split on whitespace (max 5 terms); every term must match the name, headline, bio, or an active category name (case-insensitive). `%`, `_` and `\` are matched literally. |
| `category` | Category slug (`^[a-z0-9-]{1,50}$`); must be an **active** category. |
| `location` | One of the 8 divisions (exact, e.g. `Dhaka`). Text/area match, **not** distance. |
| `maxPrice` | Integer 50-1,000,000. Matches workers whose cheapest *priced* service is <= value; quote-only workers are excluded. |
| `minExperience` | Integer 0-60 (years). |
| `sort` | `newest` (default, by publish time), `experience`, `price_asc`, `price_desc`. Missing values sort last. Ties always break on `id`, so ordering is deterministic. |
| `page` | Integer 1-500 (default 1). |
| `pageSize` | Integer 1-48 (default 12). |

Invalid values return `400` (`Validation failed` + `errors[]`). Unknown parameters are ignored, never used.
Response: `{ workers: Card[], page, pageSize, total, totalPages, sort }`. An empty directory is `200` with `workers: []`.

`Card`: `id, slug, displayName, headline, primaryCategory, categories[], serviceAreas[], experienceYears, startingPriceBdt, verification ("VERIFIED"), rating (null), reviewCount (0), publishedAt`.
`rating`/`reviewCount` are explicitly null/0 because no review feature exists yet.

### `GET /workers/:slug` (Public)
Public profile: card fields plus `bio, languages, updatedAt, services[{ category, pricingModel, basePriceBdt, pricingNotes }]`.
Hidden, unpublished, suspended, draft, malformed and unknown slugs all return the **same `404`**.
**Never** includes email, user id, review notes, suspension data, or verification details.

### Owner endpoints (session required)
| Method & path | Description |
| --- | --- |
| `PUT /me/worker-profile` | Unchanged from Step 3 (strict schema). Also recomputes `startingPriceBdt`. `slug`, `publishedAt`, `suspendedAt`, `startingPriceBdt`, `verificationStatus`... are **rejected** (`400`). |
| `POST /me/worker-profile/publish` | Make the profile public. `409` unless approved; `403` if suspended; `400` if no profile. Idempotent; allocates the slug once (`<name>-<8 hex>`, stable thereafter). |
| `POST /me/worker-profile/unpublish` | Remove from public view. Idempotent; keeps the slug. |

`GET /me` (`worker.profile`) now also returns `slug`, `publishedAt`, `suspendedAt`, `startingPriceBdt`
(never the suspension reason).

### Favorites (session required; owner is always the session user)
| Method & path | Description |
| --- | --- |
| `GET /me/favorites?page&pageSize` | Caller's favorites as cards (max pageSize 48). Workers no longer public are hidden. |
| `GET /me/favorites/ids` | Ids of the caller's still-listed favorites (max 500) to render heart state. |
| `PUT /me/favorites/:workerId` | Add (idempotent). `:workerId` is a worker-profile UUID. `404` if not publicly listed, `400` if it is your own profile or not a UUID. |
| `DELETE /me/favorites/:workerId` | Remove (idempotent, allowed even after the worker was unlisted). |

### Admin (admin only)
| Method & path | Description |
| --- | --- |
| `POST /admin/workers/:id/suspension` | `{ suspended: boolean, reason? }` (reason required to suspend; stored internally, never returned). Audit-logged; an admin cannot moderate their own profile. |
| `GET /admin/workers` | Rows now include `published` and `suspended`. |

There are **no** category create/update/delete endpoints (categories are seed/migration managed).

## Bookings (Step 5)

Full behaviour and rules: [BOOKINGS.md](BOOKINGS.md). All routes need a session; unsafe methods need the web `Origin`.
Access to a booking is limited to its **customer** and **assigned worker**: anyone else (and unknown ids) gets the same `404`.
Business-rule errors carry a stable `code` next to the message: `409` = wrong state / lost a race (e.g. `SLOT_UNAVAILABLE`,
`STALE_BOOKING`, `INVALID_TRANSITION`, `QUOTE_EXPIRED`, `QUOTE_NOT_PENDING`, `QUOTE_CHANGED`, `DUPLICATE_REQUEST`, `DISPUTE_EXISTS`),
`422` = well-formed but breaks a rule (`OUTSIDE_AVAILABILITY`, `TOO_SOON`, `TOO_FAR_AHEAD`, `MISALIGNED_TIME`, `TIME_OFF`, `AREA_NOT_SERVED`,
`SERVICE_NOT_OFFERED`, `WORKER_UNAVAILABLE`, `REASON_REQUIRED`, `TOO_EARLY`), `403` = right booking, wrong role (`NOT_ALLOWED`).

| Method & path | Who | Body / notes |
| --- | --- | --- |
| `POST /bookings` | any signed-in user | `{ workerId, categorySlug, description 10-1000, serviceArea, serviceAddress 5-300, startAt (ISO with offset), durationMinutes }`. Optional `Idempotency-Key` header (8-64 `[A-Za-z0-9_-]`): replay -> `200` with the same booking; reuse for a different payload -> `409`. `201` on creation. 10/min. Cannot book yourself. |
| `GET /bookings?role=customer\|worker&group=all\|open\|active\|history\|disputed&page&pageSize<=50` | caller | Only the caller's bookings for that side. Unanswered requests past their start show as `EXPIRED`. |
| `GET /bookings/:id` | participant | Detail: `booking`, **`actions`** (what the viewer may do now), `quotes`, `rescheduleRequests`, `dispute`, `events`. Applies lazy expiry. |
| `GET /bookings/:id/history` | participant | Events (roles, no user ids). |
| `POST /bookings/:id/accept` | assigned worker | Fixed/hourly requests only. |
| `POST /bookings/:id/decline` | assigned worker | `{ reason? }` |
| `POST /bookings/:id/cancel` | participant | `{ reason? }`; reason required for confirmed bookings. |
| `POST /bookings/:id/start`, `/complete` | assigned worker | |
| `POST /bookings/:id/mark-finished` | booking's customer | CONFIRMED or IN_PROGRESS -> COMPLETION_PENDING (payment due). Empty body only. |
| `POST /bookings/:id/arrive` | assigned professional | CONFIRMED only, inside the start window, once (`409 ALREADY_ARRIVED`). Stamps `arrivedAt`; self-reported, no location accepted. |
| `GET /bookings/:id/chat?before=<seq>` | booking's customer or assigned professional | Latest 100 messages, oldest first, `hasMore`. `409 CHAT_NOT_AVAILABLE` until the booking is accepted. |
| `POST /bookings/:id/chat/messages` | same | `{ body 1-2000, clientMessageId 8-64 [A-Za-z0-9_-] }` (strict). `201` created, `200` replay of the same key, `409 IDEMPOTENCY_KEY_REUSED` / `CHAT_READ_ONLY` / `CHAT_NOT_AVAILABLE`, `422 CHAT_LIMIT_REACHED`. |
| `POST /bookings/:id/quotes` | assigned worker | `{ laborBdt, materialsBdt?, otherBdt?, description, terms?, estimatedDurationMinutes?, validForHours? }`; `totalBdt` is rejected. |
| `POST /bookings/:id/quotes/:quoteId/accept` | booking's customer | `{ expectedTotalBdt? }` |
| `POST /bookings/:id/quotes/:quoteId/reject` | booking's customer | `{ reason? }` |
| `POST /bookings/:id/quotes/:quoteId/withdraw` | assigned worker | |
| `POST /bookings/:id/reschedule` | participant | `{ newStartAt, reason? }` |
| `POST /bookings/:id/reschedule/:requestId/accept\|reject\|withdraw` | the other party / requester | |
| `POST /bookings/:id/disputes` | participant | `{ category, description 20-2000 }`; attachment fields rejected. 5/min. |
| `GET /bookings/:id/dispute` | participant | Public messages only. |
| `POST /bookings/:id/dispute/messages` | participant | `{ body 1-2000 }` |
| `POST /bookings/:id/dispute/withdraw` | the opener | Restores the booking. |

No endpoint accepts a booking status.

### Availability
| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /workers/:slug/availability?from=YYYY-MM-DD&days<=14&duration` | Public | Bookable start times per Bangladesh day; `acceptingBookings=false` when no working hours. Hidden/unknown profiles: `404`. 60/min. |
| `GET /me/availability`, `PUT /me/availability` | the worker | `{ rules: [{ weekday 0-6 (0=Sunday), startMinute, endMinute }] }` replaces the schedule (30-min multiples, no overlaps, <= 28 windows). Always the session's own profile. |
| `POST /me/time-off`, `DELETE /me/time-off/:id` | the worker | `{ startAt, endAt, note? }`; `409` if it overlaps a confirmed booking. |

### Admin disputes (admin only)
`GET /admin/disputes?status&page`, `GET /admin/disputes/:id`, `POST /admin/disputes/:id/review`, `.../request-info {message}`,
`.../messages {body, internal?}`, `.../resolve {outcome: MARK_COMPLETED|CANCEL_BOOKING|RESTORE_BOOKING, resolution}`, `.../reject {resolution}`.
Invalid transitions -> `409 INVALID_DISPUTE_TRANSITION`; an admin who is party to the booking -> `403`.

`GET /workers/:slug` now needs no change; the web profile page calls the availability endpoint to decide whether to offer "Request a booking".

## AI assistant (Step 8)

Design, schemas and safety rules: [AI.md](AI.md). All paths are under `/api/v1`.

| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /ai/status` | Public | `{ available }` (whether the assistant is configured). |
| `POST /ai/chat` | session | Body (strict) `{ message 1-1000, intent?, locale?: auto\|en\|bn, action?: message\|search }`; no user id or history field. Returns `{ kind, message, language, intent, intentSources, clarification, recommendations[{ rank, matchedOn, worker }], total, relaxations, answer, notes, mode }`. `recommendations[].worker` is the public card, re-read from PostgreSQL. Errors: `503 AI_NOT_CONFIGURED`, `429 AI_RATE_LIMITED` (+`retryAfterSeconds`), `504 AI_TIMEOUT`, `502 AI_UNAVAILABLE`. Per-user limit `AI_RATE_LIMIT_PER_MINUTE`; 30/min/IP. |
| `GET /internal/ai/workers`, `GET /internal/ai/categories` | AI service only | Bearer `APP_API_SERVICE_TOKEN`. Same arguments and projection as `GET /workers` (first page, `pageSize` <= 24) and the active category list. `404` when the assistant is not configured; `401` for any other credential, including a user session. Not for browsers; block `/api/v1/internal/` at the proxy. |

## Operations (Step 10)

| Method & path | Access | Notes |
| --- | --- | --- |
| `GET /health/live` | Public | `{ status: "ok" }`. No dependency checks (liveness). Not rate-limited. |
| `GET /health`, `GET /health/ready` | Public | `{ status: "ok", checks: { database: "ok" } }`, or `503 { checks: { database: "unavailable" } }` after a 2 s database check. No versions, hosts or error text. |
| `GET /admin/ops/status` | `ops.read` | `{ database, databaseLatencyMs, ai, payments, mail, integrations: [{ id, label, status, detail, probed }], queues: { ..., ticketsOpen, ticketsUnassigned }, audit: { headSeq, lastEntryAt }, platform: { maintenanceMode }, runtime }`. Counts, states and flags only; `probed: false` means "configuration present", not "verified with the provider". |

Every response carries `X-Request-Id`. A client may send its own (8-64 characters of `A-Za-z0-9_-`; anything else is replaced). Unexpected errors answer `500 { statusCode, error, message: "Internal server error", requestId }`.

## Reviews, community, proposals and moderation (Step 9)

Full rules, state machines and error codes: [COMMUNITY.md](COMMUNITY.md). Summary (all under `/api/v1`; "session" = signed-in verified user; unsafe methods need the web `Origin`; request bodies are strict, so unknown or protected fields are `400`):

| Method & path | Access | Notes |
| --- | --- | --- |
| `POST /bookings/:id/review` | the booking's customer | `{ rating 1-5, comment? <=1000 }`. Booking must be `COMPLETED` (`422 BOOKING_NOT_REVIEWABLE`) with a provider-verified payment (`422 PAYMENT_NOT_VERIFIED`); one per booking (`409 REVIEW_EXISTS`); someone else's booking is `404`. |
| `GET\|PUT\|DELETE /bookings/:id/review` | the booking's customer | Read own / edit within 14 days while visible (`422 EDIT_WINDOW_CLOSED`, `409 REVIEW_NOT_EDITABLE`) / withdraw (final). |
| `GET /workers/:slug/reviews?page&pageSize` | Public | Counted reviews only (visible + booking completed + payment verified) with `summary {rating, reviewCount, distribution}`; `verifiedBooking` is derived by the server; public first names only. |
| `GET /bookings/:id` | participant | Adds `review` (customer: `{canReview, review}`; professional: a public review or null). |
| `GET /workers`, `/workers/:slug`, `/me/favorites` | as before | `rating` (1 decimal) and `reviewCount` are now real; null/0 without reviews. |
| `GET\|POST /community/posts`, `GET\|PATCH\|DELETE /community/posts/:id` | session | List `?scope=all\|mine`. Edit/delete: author only. 10 posts/hour/user. |
| `GET\|POST /community/posts/:id/comments`, `PATCH\|DELETE /community/comments/:id` | session | Flat comments; edit/delete: author only. |
| `POST /community/posts/:id/reactions`, `DELETE /community/posts/:id/reactions/:type` | session | Idempotent like; `200 { reacted, likeCount }`. |
| `POST /community/reports`, `POST /reviews/:id/report` | session | `{ reason, details? }` (+ `targetType`, `targetId` for the first). One report per user per item (`409`), not your own content (`422`), 5/min, 20/day. Reporting hides nothing. |
| `GET\|POST /feature-proposals`, `GET /feature-proposals/:id` | session | Sorted by votes or date; created `SUBMITTED`. |
| `POST\|DELETE /feature-proposals/:id/vote` | session | One vote per user; `409 VOTING_CLOSED` after a decision. |
| `GET /admin/moderation/overview`, `GET /admin/moderation/history` | admin | Counts; moderation-only audit history. |
| `GET /admin/reports`, `GET /admin/reports/:id`, `POST /admin/reports/:id/decision` | admin | Queue (25/page), detail with context, decision `REVIEW\|RESOLVE\|DISMISS` (+ explicit `contentAction`). |
| `POST /admin/moderation/(posts\|comments\|reviews\|proposals)/:id/visibility` | admin | `{ hidden, reason }`. |
| `GET /admin/proposals`, `POST /admin/proposals/:id/status` | admin | Lifecycle decisions; `needsReview=true` lists proposals at the vote threshold. |

## Payments (Step 6)

Design, state machines and the provider flows: [PAYMENTS.md](PAYMENTS.md). All paths are under `/api/v1`. References look like `FIN` + 24 hex characters; a malformed or foreign reference is the same `404`.

### Customer (session required; the payer is always the session user)
| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /payments/providers` | any signed-in user | `[{ provider, label, available, mode: "sandbox"\|"live"\|null, minAmountBdt, maxAmountBdt }]`. `available:false` = not configured. No credentials. |
| `POST /bookings/:id/payments` | the booking's customer | Body `{ provider: "BKASH"\|"SSLCOMMERZ" }` **only** (strict: `amount`, `currency`, `status`, ids -> `400`). Optional `Idempotency-Key`. `201 { payment, checkoutUrl }` (`200` on replay). Errors: `404` (not yours), `409 ALREADY_PAID \| PAYMENT_IN_PROGRESS \| PAYMENT_UNDER_REVIEW \| IDEMPOTENCY_KEY_REUSED`, `422 BOOKING_NOT_PAYABLE \| NO_AGREED_AMOUNT \| AMOUNT_OUT_OF_RANGE \| PROVIDER_UNAVAILABLE \| TOO_MANY_ATTEMPTS \| UNSUPPORTED_CURRENCY`, `502 PROVIDER_ERROR` (nothing charged). 10/min. |
| `GET /payments?page&pageSize` | the payer | Own payments, newest first. |
| `GET /payments/:reference` | the payer | **The authoritative status.** Re-verifies with the provider first if the attempt is unresolved (throttled). Returns status, amount, refunds and a history of customer-visible events. |
| `POST /payments/:reference/refunds` | the payer | `{ reason 10-500, amountBdt? }` (strict). Verified payment + `CANCELLED` booking only. `409 REFUND_IN_PROGRESS`, `422 REFUND_NOT_ELIGIBLE \| PAYMENT_NOT_REFUNDABLE \| REFUND_EXCEEDS_REMAINING`. Optional `Idempotency-Key`. 5/min. A request moves no money. |
| `GET /bookings/:id` | participant | Now includes `payment` (customer: state, `canPay`, attempts; professional: only `{ state: UNPAID\|PAID\|REFUNDED }`). |

The payment object never contains credentials, provider session ids, the checkout URL (except in the initiation response), database ids or raw provider data. `providerTransactionId` (the receipt number) appears only after verification.

### Provider callbacks (public: no session, no Origin check; every field is untrusted)
| Method & path | Caller | Behaviour |
| --- | --- | --- |
| `GET /payments/callbacks/bkash/:reference?paymentID&status&signature` | customer's browser from bKash | Executes (once) and verifies with bKash; `303` to `FRONTEND_ORIGIN/payments/<reference>?returned=1`. |
| `POST /payments/callbacks/sslcommerz/{success\|fail\|cancel}` (form) | customer's browser from SSLCOMMERZ | Validates with the Order Validation API; `303` to the same return page. Other `:kind` -> `404`. |
| `POST /payments/ipn/sslcommerz` (form) | SSLCOMMERZ server | Same verification; always `200 OK` (plain text); `500` only on a transient internal error so the provider retries. |

Unknown or malformed references redirect to `FRONTEND_ORIGIN/payments` without error. Register `https://<public-origin>/api/v1/payments/ipn/sslcommerz` as the store's IPN URL; the other URLs are sent per payment.

### Admin (admin only; an admin cannot act on a booking they take part in)
| Method & path | Notes |
| --- | --- |
| `GET /admin/payments?status=&page` | `status` may be a payment status or `NEEDS_ATTENTION` (review items + paid-but-booking-ineligible). No emails or internal ids. |
| `GET /admin/payments/:reference` | Detail with the full sanitised event trail and refunds. |
| `POST /admin/payments/:reference/reconcile` | Re-verify with the provider (10/min, audit-logged, idempotent). |
| `POST /admin/payments/reconcile-stale` | Re-verify up to 20 stale unresolved payments (2/min). |
| `POST /admin/payments/:reference/refunds` | `{ reason, amountBdt? }`; creates an already-`APPROVED` refund for a verified payment or verified duplicate. |
| `GET /admin/refunds?status=&page`, `GET /admin/refunds/:id` | |
| `POST /admin/refunds/:id/approve` | `{ amountBdt?, note? }` - a decision only. |
| `POST /admin/refunds/:id/reject` | `{ note }` |
| `POST /admin/refunds/:id/process` | Calls the provider's refund API (only if enabled), then verifies via the refund-status API. `422 REFUNDS_NOT_SUPPORTED` otherwise. |
| `POST /admin/refunds/:id/reconcile` | Re-query a `PROCESSING` refund. |

No endpoint accepts a payment or refund status, an amount for a payment, a provider reference or a refunded total.


## Admin panel (every route needs the permission shown; see [ADMIN.md](ADMIN.md))

Every `/admin/*` route declares its permissions with `@RequirePermission`; a test fails if one does not. Mutations that move money, remove access or publish content need `"confirm": true` in the body and answer `400` without it. Errors use the usual shapes plus a stable `code` for business rules. Lists are paginated (`page`, `pageSize`, answer `total`, `totalPages`).

| Area | Endpoints (permission) |
| --- | --- |
| Dashboard | `GET /admin/dashboard?days=7\|14\|30\|90` (`dashboard.view`; sections filtered by the caller's other permissions) |
| Users | `GET /admin/users`, `GET /admin/users/:id` (`users.read`); `POST /admin/users/:id/suspension` `{ suspended, reason, confirm }` (`users.suspend`); `POST /admin/users/:id/admin-access` `{ roleId \| null, reason, confirm }` (`admins.assign`) |
| Roles | `GET /admin/roles`, `/admin/roles/permissions`, `/admin/roles/:id` (`roles.read`); `POST /admin/roles`, `PATCH`/`DELETE /admin/roles/:id` (`roles.manage`; `DELETE` needs `{ confirmKey }`) |
| Workers | `GET /admin/workers`, `/admin/workers/:id` (`workers.read`); `POST /admin/workers/:id/verification` (`workers.review`); `POST /admin/workers/:id/suspension` (`workers.suspend`); `GET /admin/workers/:id/documents/:kind` (`workers.documents.view`, audited, image bytes) |
| Worker documents (owner) | `GET /me/worker-profile/documents` (metadata only); `PUT`/`DELETE /me/worker-profile/documents/:kind` (`PUT` body is the raw image, JPEG/PNG/WebP up to 3 MB) |
| Catalogue | `GET /admin/categories` (`catalog.read`); `POST`, `PATCH /:id`, `PUT /order`, `DELETE /:id` `{ confirmSlug }` (`catalog.manage`). Public `GET /categories` returns top-level categories with nested `subcategories`. |
| Bookings | `GET /admin/bookings`, `/admin/bookings/:id` (`bookings.read`); disputes unchanged (`disputes.read` / `disputes.manage`) |
| Payments | `GET /admin/payments` (filters `status, provider, q, from, to`), `/admin/payments/:reference`, `/admin/refunds` (`payments.read`); reconcile (`payments.reconcile`); `POST /admin/payments/:reference/refunds` and `/admin/refunds/:id/approve` `{ confirm }` (`refunds.decide`); `POST /admin/refunds/:id/process` `{ confirm }` (`refunds.process`) |
| Finance | `GET /admin/finance/summary`, `/commission`, `/commission/export` (CSV) (`finance.reports`; range at most 366 days) |
| Support | user: `POST/GET /support/tickets`, `GET /support/tickets/:id`, `POST .../messages`, `POST .../close`; admin: `GET /admin/support/tickets`, `/:id`, `/assignees` (`support.read`), `POST /:id/messages`, `PATCH /:id` (`support.manage`) |
| Content | `GET /admin/content/:posts\|comments\|reviews\|proposals` (`moderation.read`); hide/restore and report decisions as before (`moderation.manage`) |
| AI | `GET /admin/ai/status`, `/admin/ai/knowledge[/:id[/revisions/:v]]` (`ai.read`); create/edit/status/revert/`POST /admin/ai/sync { confirm }` (`ai.manage`); service-only `GET /internal/ai/knowledge` (published documents, `APP_API_SERVICE_TOKEN`) |
| Communication | `GET/POST /admin/announcements`, `PATCH /:id`, `POST /:id/publish { confirm }`, `POST /:id/archive`, `POST /admin/notifications` (`notifications.manage`); readers: `GET /announcements` (public), `GET /me/announcements`, `GET /notifications`, `/notifications/unread-count`, `POST /notifications/read-all`, `/notifications/:id/read` |
| Audit | `GET /admin/audit`, `/actions`, `/export` (`audit.read`); `GET /admin/audit/verify` (`audit.verify`) |
| Settings | `GET /admin/settings` (`settings.read`); `PUT /admin/settings/:key { value, reason }` (`settings.manage`); public `GET /config/platform` |
