# Architecture (as implemented)

Target architecture is in [SRS.md](SRS.md) §6–7. This file records what exists.

## Layout
`frontend/` (Next.js), `backend/` (NestJS API + Prisma), `rag_agent/` (Python FastAPI AI service, Step 8).
The repository keeps these three top-level folders; each holds only its own code.

```
Browser --(same origin)--> Next.js web app (:3000)
                              |  rewrites /api/v1/*  (dev; use a reverse proxy in production)
                              v
                         NestJS API (:4000)  --Prisma--> PostgreSQL
                              |-- Better Auth (mounted at /api/v1/auth/*)
                              '-- SMTP (email)        Google OAuth (optional)
```

## Backend (Step 3)
- **NestJS 12 (ESM), Express 5, Prisma 7 (pg driver adapter), PostgreSQL, Vitest.**
- **Authentication provider: [Better Auth](https://better-auth.com) 1.7** (maintained library; no
  hand-written crypto). It owns password hashing, sessions, email-verification and reset tokens,
  Google OAuth, origin checks, and auth-endpoint rate limiting. It is built in
  `backend/src/auth/auth.factory.ts` and mounted at `/api/v1/auth/*` before the JSON body parser
  (`backend/src/app.setup.ts`).
- **Sessions:** server-side rows in PostgreSQL + an HttpOnly cookie. Cookie cache is off so logout,
  password reset and "log out other devices" take effect immediately. `sign-out` revokes only the
  **current** session; `revoke-other-sessions` and password reset revoke the rest.
- **Authentication is separate from authorization.** `AuthGuard` (global, default deny) only
  establishes who the caller is. Permissions are decided by `AdminGuard`, `ApprovedWorkerGuard`,
  and the pure functions in `src/auth/policies.ts`. The role is read from the database on every request.
- **Request pipeline:** helmet -> Better Auth handler (`/api/v1/auth/*`) -> JSON parser ->
  `OriginGuard` (CSRF) -> `ThrottlerGuard` -> `AuthGuard` -> route guards -> Zod validation -> service.
- **Modules:** `config` (validated env), `prisma`, `mail`, `auth`, `categories`, `me` (customer profile),
  `worker` (onboarding + approved-worker workspace), `admin` (review queue), `health`.

## Data model (Prisma, `backend/prisma/schema.prisma`)
- Better Auth core: `user`, `session`, `account`, `verification`, `rateLimit`. `user.role` (`USER`|`ADMIN`) is DB-only. Email verification uses the Better Auth `emailOTP` plugin (6-digit hashed code); per-address send throttles reuse `verification` rows, so no extra table. Details: [AUTH.md](AUTH.md).
- `customer_profile` (1:1 with user), `worker_profile` (1:1 with user), `worker_service`
  (worker x category with pricing), `service_category` (seeded), `audit_log`.
- **One account, both capabilities:** capabilities are *rows*, not roles: having a `customer_profile`
  and/or a `worker_profile`. Nothing requires separate accounts.
- `worker_profile.onboardingStatus` (`DRAFT`|`SUBMITTED`) is separate from `verificationStatus`
  (`NOT_SUBMITTED`|`PENDING`|`VERIFIED`|`REJECTED`|`RESUBMISSION_REQUIRED`).

## Discovery (Step 4)
- **Source of truth:** categories, worker profiles and counts come from PostgreSQL through the API.
  `frontend/src/lib/category-icons.tsx` holds only presentation (icons); its `FEATURED_CATEGORIES`
  list feeds the decorative hero panel and header menu (links into real category pages).
- **Lifecycle** (`worker_profile`): `DRAFT` -> submit -> `PENDING` -> admin `VERIFIED` -> owner **publish** -> public.
  Admin `suspend` hides it again. Visibility is one shared filter, `ELIGIBLE_WORKER`
  (`backend/src/workers/eligibility.ts`).
- **Public projection:** explicit Prisma `select`s (`cardSelect`, `profileSelect`) define what leaves the
  server; private columns cannot leak because they are never selected.
- **Search:** Prisma `where`/`orderBy` only (no raw SQL). Text uses case-insensitive `contains` with
  LIKE-escaping. `sort` is a closed enum mapped to fixed ordering lists ending in `id`.
- **Denormalised `startingPriceBdt`:** minimum priced service, maintained in the same transaction as
  service edits, so price filter/sort can use a b-tree index.
- **Indexes added:** `publishedAt`, `startingPriceBdt`, `experienceYears`, GIN on `serviceAreas`,
  `worker_service(categoryId)`, `favorite(userId, createdAt)`, unique `slug`, unique `(userId, workerProfileId)`.
  Text search is a sequential scan over the already-filtered published set (see limitations).
- **Favorites:** `favorite` table with a unique `(userId, workerProfileId)` constraint; identity is always the session.
- **Frontend:** `/workers`, `/services`, `/services/[slug]` and `/workers/[slug]` are server components that
  fetch the **public** API with `cache: "no-store"` (no cookies forwarded, so no per-user data can be cached or
  rendered). Filters are a plain GET form, so URLs are shareable and work without JavaScript; the heart button
  is the only client-side piece (`favorites-store.ts`, cleared when the session user changes).
- Unknown/hidden profile and category pages render the not-found UI with `noindex`; because content is streamed
  (Cache Components), the HTTP status of that response is `200` (soft 404), not `404`.

## Bookings (Step 5)
Details: [BOOKINGS.md](BOOKINGS.md). Summary of the architecture:
- **Module:** `backend/src/bookings/` (`BookingCore` = loading, lazy expiry, state transitions, events, presentation; `BookingsService`, `QuotesService`,
  `RescheduleService`, `DisputesService`, `AvailabilityService`; controllers for bookings, availability and admin disputes). A `Clock` provider is injected so
  tests control time.
- **One state machine** (`booking.state.ts`) is the only place statuses change; there is no endpoint that takes a status. Each transition is a conditional UPDATE
  (`WHERE status = <read status>`) plus an event row in the same transaction.
- **Concurrency:** per-worker row lock (`SELECT ... FOR UPDATE`) in every confirm/reschedule/time-off transaction, **and** a PostgreSQL exclusion constraint
  (`booking_no_overlap`, needs `btree_gist`) as the final guard. A per-(customer, worker) advisory lock plus an optional `Idempotency-Key` guard duplicate requests.
- **Database-level invariants** (in the migration SQL, since Prisma cannot model them): exclusion constraint, one pending quote / reschedule request per booking
  (partial unique indexes), `quote.total = labor + materials + other`, time-order and availability-bound CHECKs.
- **Frontend:** `/workers/[slug]/book` (3-step form with real slots), `/bookings`, `/bookings/[id]` (renders buttons **only** from the server's `actions` list),
  `/account/availability`. The profile page offers "Request a booking" only when the professional has published working hours.
- **No notification system exists**: lifecycle events are stored in `booking_event` (the future outbox). Nothing is emailed.

## Payments (Step 6)
Details: [PAYMENTS.md](PAYMENTS.md). Summary:
- **Module:** `backend/src/payments/` (`PaymentsService`, `PaymentCallbacksService`, `RefundsService`, three controllers, provider adapters under `providers/`). It does not import the bookings module;
  booking detail uses the pure `paymentSummary()` query. A verified payment is the only thing that moves a finished booking (`COMPLETION_PENDING`) to `COMPLETED`; it changes no other booking status.
- **Provider boundary:** adapters (`BkashAdapter`, `SslcommerzAdapter`) implement `PaymentProviderAdapter`: protocol only, no database, neutral results. One injectable `HttpClient` is the only network access (a fake replaces it in tests).
- **One verification path:** every callback, poll and admin reconcile ends in `PaymentsService.applyVerification`, a single transaction (booking lock -> payment lock) that compares the provider's report with the stored attempt.
- **Ledger:** `payment_event` (append-only trigger, `dedupeKey` uniqueness). Money is integer BDT; provider decimals are parsed exactly (`money.ts`).
- **CSRF:** the global Origin guard now honours `@SkipOriginCheck()`, used only by the provider callback controller.
- **Frontend:** `/bookings/[id]/pay` (checkout), `/payments` (history), `/payments/[reference]` (the return page: it asks the server and polls; a URL parameter is never read as status).

## Operations (Step 10)
Details: [RUNBOOK.md](RUNBOOK.md), [AUDIT.md](AUDIT.md). Summary:
- **Request ids and logs:** `requestLogger` (first middleware) sets `X-Request-Id` (an inbound id is accepted only if it is a short harmless token) and writes one JSON access-log line per request using the **route template**; the id is kept in an `AsyncLocalStorage` and becomes the AI service's correlation id. `AllExceptionsFilter` turns unexpected errors into a generic 500 carrying the request id and logs only a safe summary.
- **Health:** `/health/live` (no dependencies), `/health` and `/health/ready` (database, 2 s), and admin-only `/admin/ops/status` (AI reachability, provider modes, human work queues). The AI service, payments and SMTP are not readiness dependencies.
- **Database limits:** pool size, connect timeout and statement timeout are configuration; `audit_log` is append-only via trigger.
- **Packaging:** one Dockerfile per service (the API has a separate `migrate` target for the release job); a disposable compose stack and a GitHub Actions workflow verify them.

## Reviews, community and moderation (Step 9)
Details: [COMMUNITY.md](COMMUNITY.md). Summary:
- **Modules:** `reviews/` (booking-linked reviews, `ratings.ts` = the one definition of a counted review), `community/` (posts, comments, likes, reports; also hosts the proposals and moderation controllers), `proposals/`, `moderation/` (admin API). Reviews are not a dependency of bookings: the booking detail calls the pure `reviewSummary()` query, like payments.
- **Ratings are computed, not cached:** one grouped query per page of workers (`ratingSummaries`), counting reviews that are `VISIBLE` and whose booking is `COMPLETED` with a verified payment. `WorkersService`, `FavoritesService` and the AI assistant's hydration all go through `toCard(row, summary)`.
- **One authority for privileged actions:** `ModerationService`. Every state change is a conditional `UPDATE ... WHERE status = <read>` in a transaction together with its `audit_log` row; content visibility and report status are separate and linked only by an explicit `contentAction`.
- **Plain text only** for all user content; the web app renders it as React text. Community, proposals and admin pages are signed-in and `noindex`; reviews on public profiles are public.
- **Database invariants** (migration SQL): rating range, text lengths, hidden-needs-reason, report-has-exactly-one-matching-target, unique review/reaction/vote/report.

## AI assistant (Step 8)
Details: [AI.md](AI.md). Summary:
- **A separate Python FastAPI service in `rag_agent/`** (private; browsers never reach it). The main API authenticates the user, rate-limits per user, calls it with a service token, validates its answer with a strict schema, and **re-reads every recommended worker from PostgreSQL** (`WorkersService.findCardsByIds`: the same `ELIGIBLE_WORKER` rule plus the stated filters). Worker facts shown to users never come from the AI.
- **The AI service has no database access.** Its tools are two read-only endpoints, `GET /api/v1/internal/ai/{workers,categories}`, guarded by `ServiceTokenGuard` and backed by the public search code. Two different secrets, one per direction.
- **Pipeline, not an agent:** screen -> catalogue -> extract intent (OpenRouter, optional) -> merge -> route (knowledge answer | clarification | search -> verify -> respond). The model never selects tools, arguments or worker ids. LangChain/LangGraph and a vector store were evaluated and deliberately not used (see AI.md).
- **No schema change, nothing persisted.** The conversation state is the filter set, held by the client and re-validated each request.
- **Frontend:** `/assistant` (login required) with chips for the active filters, suggested follow-ups, relaxations, and a link to the normal search that doubles as the failure fallback.
- `WorkersService.search` now builds its `where` through the exported `buildSearchWhere` (behaviour unchanged; reused for hydration).

## Account linking
Google never auto-links to an existing email account (see SECURITY.md). Linking is explicit
(`linkSocial`) for a signed-in user.

## Frontend
- Next.js 16 App Router with Cache Components enabled. Pages are static; the
  only runtime-dynamic route is `/workers`, which reads `searchParams` inside a
  `<Suspense>` boundary.
- Tailwind v4 with tokens in `src/app/globals.css`: navy `brand-*`, teal
  `accent-*`, neutrals (`canvas`, `surface`, `line`, `ink*`), status colours,
  `rounded-control|card|panel`, `shadow-card|lift|pop`, type scale
  (`text-display|h1|h2`). Font: Plus Jakarta Sans with Noto Sans Bengali fallback.
- Icons: `lucide-react` only. No emoji, no external images.
- Light theme only (the starter's dark-mode block was removed so the palette
  stays consistent with the SRS visual direction).

## Integration boundaries (for later steps)
| Boundary | File | Today | Replace with |
| --- | --- | --- | --- |
| Categories | `src/lib/categories.ts` | Presentation-only seed list | `GET /api/v1/categories` |
| Professionals | `src/lib/professionals.ts` | Returns `[]` (never fabricates) | `GET /api/v1/workers` |
| Search | `src/components/home/search-form.tsx` → `/workers?q&location&category` | Navigates; page shows honest empty state | Search API results |
| Auth | `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` | Real (Better Auth via backend) | - |
| Account / onboarding | `/account`, `/onboarding`, `/onboarding/customer`, `/onboarding/worker` | Real; data from `/api/v1/me*` | - |
| Worker profile | `ProfessionalCard` links to `/workers/[id]` | Route not built; card never rendered without data | Step 4+ |
| Categories (worker onboarding) | `GET /api/v1/categories` | Real (DB). The public marketing pages still use `src/lib/categories.ts` | Unify in the discovery step |

### Frontend auth notes
- `src/lib/auth-client.ts`: Better Auth browser client (same origin). `src/lib/api.ts`: typed fetch for app endpoints.
- `src/proxy.ts` is an **optimistic** gate (cookie present?). Real enforcement is the backend; pages also call `/me` and redirect on `401`.
- Header/mobile nav reflect the session (`authClient.useSession`) for convenience only.
