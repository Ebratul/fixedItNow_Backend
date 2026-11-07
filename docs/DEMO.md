# Demo access ("Explore Demo")

Visitors can try FixedItNow as a **Demo Customer**, **Demo Worker** or **Demo Admin** without registering and without a password. An administrator decides, per role, whether the option is *listed* on the login page and whether the backend will *start* sessions for it. Everything a visitor sees is fictional, and nothing a visitor does can reach a real user, a real payment provider or a real inbox.

> **Status:** implemented and covered by automated tests (see section 12). Not run: a hosted (Vercel) deployment, the real bKash sandbox. Nothing here was applied to the remote database in `backend/.env`.

## 1. Quick start

```bash
cd backend
npm run db:deploy        # applies the two demo migrations (additive)
npm run db:seed          # reference data (categories, admin roles), as before
npm run demo:seed        # the fictional demo accounts and data (idempotent, never switches anything on)
```

Then sign in to the admin panel as a real administrator: **Admin → Platform settings → Demo Access Settings**. Everything is **off and hidden by default**. For each role turn on *Show on the login page* and *Allow new demo sessions*. The login page then shows an "Explore Demo" section.

No new environment variable is needed. (`DATABASE_URL`, `BETTER_AUTH_*`, `FRONTEND_ORIGIN` are the existing ones; nothing demo-related is ever exposed to the browser through `NEXT_PUBLIC_*`.)

| Command | What it does |
| --- | --- |
| `npm run demo:seed [-- --allow-production]` | Creates what is missing: 11 demo users, 7 fictional professionals' profiles, 11 bookings with chat, payments, reviews, a dispute, tickets, posts. Re-running adds nothing and never undoes what visitors did. Refuses to run with `NODE_ENV=production` unless `--allow-production`. |
| `npm run demo:reset -- --yes [--allow-production]` | Deletes **only** records owned by demo accounts, signs every demo visitor out, then re-seeds with fresh dates. See section 9. |

## 2. How demo login works

```
login page ──GET /api/v1/demo/options──► only the options an admin made visible (+ "available" flag)
click "Continue as Demo Customer"
   └─POST /api/v1/auth/demo/sign-in {"role":"customer"}   (a Better Auth plugin: src/auth/demo-login.plugin.ts)
        1. Origin must be the web app (login-CSRF protection), body must be exactly {role} with one of three names
        2. per-IP rate limit (10/min); setting demo.customer.enabled must be true (read fresh from the database)
        3. the user is looked up by the fixed demo role (never from the request); it must exist, be verified and unsuspended
        4. already signed in? same demo user → 200 without a second session; anyone else → 409 "log out first"
        5. expired demo sessions are swept; more than 300 live sessions for the role → 503 DEMO_BUSY
        6. a normal server-side session row (2 hours, never extended) and Better Auth's signed cookie:
           HttpOnly, SameSite=Lax, Secure in production, no Max-Age (ends with the browser session)
        7. response: { role, redirectTo }  (no token in the body)
```

After that it is an ordinary session: the global `AuthGuard` validates it on every request, reads the role and permissions **from the database**, and decides the request's data realm (section 5). `/me` returns `demo: { role }`, which makes the web app show the **Demo mode** bar with an *Exit demo* button (it calls the normal sign-out).

Redirects: customer → `/account`, worker → `/bookings?role=worker`, admin → `/admin`. A deep link `/demo/customer|worker|admin` shows the same card for one role (it never logs in on a plain GET; the button POSTs).

What a client can **not** do: choose a user id, an email, a role other than the three names, extra body fields (strict schema → 400), start a session from another origin (403), or get a token. Role names are mapped to users on the server (`demo_role` is a unique column).

## 3. Visibility and availability

Two independent switches per role, stored in the existing `platform_setting` table (keys `demo.<role>.visible` and `demo.<role>.enabled`), changed only through the existing audited `PUT /admin/settings/:key` (needs `settings.manage`, a reason is required, the change is written to the hash-chained audit log with the acting administrator, the old and new value and the reason). Both default to **off**.

| visible | enabled | Login page | `POST /auth/demo/sign-in` / direct link |
| --- | --- | --- | --- |
| off | off | not listed | **refused** (403 `DEMO_DISABLED`) |
| on | off | listed as *Unavailable* (cannot be started) | **refused** |
| off | on | not listed | **works** (reachable only by someone who knows `/demo/<role>` or the API) |
| on | on | listed, clickable | works |

Rule: **a hidden option never bypasses a disabled one.** `enabled` is the only gate the backend checks. `visible` only decides what `GET /demo/options` lists; a hidden role is absent from that response (no hint it exists), and the endpoint exposes nothing else (no user, no id, no setting that is off).

**Existing sessions** (documented policy): switching `enabled` **off** signs out every open demo session of that role immediately (rows deleted, an extra audit entry `demo.sessions_end` records the count), and the authentication guard refuses any session of a disabled role anyway (401 `DEMO_DISABLED`), so a cleanup that lagged or a second server instance cannot keep it alive. Switching `visible` off changes nothing for open sessions. A failed update (validation error, audit write failure) leaves the last confirmed value: the change and its audit row commit in one transaction and the admin page only shows what the server returned.

The demo switches are invisible to the demo administrator (`GET /admin/settings` filters `demo.*` for demo sessions) and unwritable by it.

## 4. Demo accounts and data

`src/demo/demo.fixtures.ts` (used by `demo:seed`, `demo:reset` and the tests). Everything is invented: names carry "(Demo)", addresses end in `.invalid` (RFC 2606, can never receive mail), there is no NID, phone number, payment credential or identity document, and none of the 11 users has a password (no `account` row), so no credential flow can ever sign in as them.

| Account | Role | Notes |
| --- | --- | --- |
| Demo Customer, Demo Worker, Demo Admin | the three login identities (`demo_role` CUSTOMER / WORKER / ADMIN) | the admin holds the system role `demo_admin` |
| Nusrat, Tanvir | fictional customers | authors of reviews, posts, a ticket |
| Karim, Shafiq, Mitu, Anwar, Jamal | fictional published, verified professionals | make the directory, search and categories look alive; they have no login |
| Rubel | fictional applicant, verification PENDING | something for the admin verification screen |

Bookings cover every state: requested, quoted (pending quote), confirmed (with chat), finished and awaiting payment, completed and paid (review), cancelled after paying (flagged for payment review, refund request waiting), disputed (with dispute thread), plus four completed jobs with reviews for the other professionals. Dates are relative to the moment the seed runs and upcoming jobs are on the professionals' working days (Sunday–Thursday). Re-run `demo:reset` now and then to refresh them.

All rows are created with `isDemo = true`, which is what puts them in the demo realm. The seed uses the unscoped client on purpose and refuses to run over a reserved demo address that belongs to a non-demo account.

## 5. Isolation: the demo realm

A shared demo must not leak into the real platform, and real data must not leak into a demo. Two independent barriers:

1. **Application: the realm firewall** (`src/prisma/realm.ts`). `User.isDemo` marks demo accounts. `AuthGuard` decides the realm of each request from the database (never from the client) and stores it in the request context; `PrismaService` is a Prisma client extension that adds the realm condition (through the owning user) to **every** read, update and delete on every model, including inside transactions. So a demo session cannot read or change a real row, and ordinary sessions, public visitors and payment callbacks never see a demo row: real admin lists, counts, dashboards and revenue reports exclude demo data, and the public directory, categories, profiles, reviews and slots hide the demo professionals. A real record requested by id from a demo session is simply "not found", and vice versa.
   - Every Prisma model must be classified (`SCOPES`, or `SHARED` for reference data: categories, settings, admin roles, announcements, knowledge base). An unclassified model makes queries on it throw, and a unit test fails until it is classified.
   - Raw SQL is not covered by the extension, so the six raw reads that return data (dashboard series, finance daily/category, category worker counts) filter by realm themselves; the others are row locks.
   - Public routes that depend on the realm (`/workers`, `/workers/:slug`, `…/reviews`, `…/availability`, `/categories`) use `@OptionalAuth()`: it only looks at the session cookie to pick the realm and never rejects.
   - Authentication itself (Better Auth, `AuthGuard`) uses `prisma.unscoped`, because it has to find demo users to authenticate them.
   - Fail closed: outside a request the realm is "real" (demo rows invisible); if the request context that carries the realm is missing, a demo session is refused.
2. **Database triggers** (migration `20261103010000_demo_access`), independent of the application: a booking cannot connect a demo account with an ordinary one; a `DEMO` payment is only for demo customers and demo customers only have `DEMO` payments (never live); `is_demo` and `demo_role` are immutable (a user cannot enter or leave the demo realm); an ordinary account cannot hold the `demo_admin` role; a demo account cannot be an administrator except the demo administrator; at most one user per demo role.

## 6. What the demo roles can and cannot do

Enforced in the backend by `DemoGuard` (a global guard after authentication) plus the realm firewall. A banner or a disabled button is only a courtesy.

**Demo Customer** — everything a customer does, inside the demo realm: browse and search professionals and categories, profiles, request bookings (only demo professionals exist for them), accept/reject quotes, booking chat, pay with the simulated payment, review, favourites, tickets, community, notifications.
**Demo Worker** — dashboard and public profile, edit services and availability, accept/decline/quote, arrival → start → finish, chat, reviews, payments seen on bookings.
Both are refused (403 `DEMO_RESTRICTED`): the AI assistant (an external, paid model), identity-document uploads, and, for the customer, becoming a worker; for the shared worker profile, resubmitting or taking it offline (it would break the demo for everybody). They can never change credentials or turn into an ordinary account (section 7). A write budget of 60 state-changing requests per 10 minutes per session applies (`DEMO_RATE_LIMITED`, 429).

**Demo Admin** — the admin panel with fictional data, **read-only**:
- Can read: dashboard and analytics, users, workers and the verification queue, bookings, disputes, payments and refund requests, finance reports, support tickets, community moderation queues, and the non-demo platform settings. All of it comes from the demo realm only.
- Cannot, whatever route or permission: any request that changes state (`DemoGuard` refuses every non-GET with 403 `DEMO_READ_ONLY`, on every route, including user suspension, role/admin changes, refund decisions or processing, payment re-verification, settings, catalogue, announcements, notifications, knowledge base); read the real admin roles, audit trail, environment/integration status (`ops`), catalogue, identity documents; see or change the demo-access switches; use the AI assistant.
- Permission boundary: a dedicated system role `demo_admin` (immutable in the database) whose effective permissions are **intersected with an allow-list in code** (`DEMO_ADMIN_PERMISSIONS`), so widening the role row, even behind the application's back, grants nothing. The real `super_admin` is never given to a demo account (a trigger refuses it), and the role cannot be given to an ordinary account (API 403 `DEMO_ROLE`, trigger as backstop). No ordinary account is ever made an administrator by any of this.

## 7. Sessions and account protection

- Server-side session row, Better Auth signed cookie (HttpOnly, SameSite=Lax, Secure in production). Nothing about the session or role is stored in `localStorage`; the web app only keeps what the server tells it.
- 2 hours, not extended. Logout deletes the row (a copied cookie is useless afterwards). Expired demo sessions are swept at the next sign-in.
- CSRF: the existing origin guard for all routes; `/auth/demo/sign-in` checks Origin itself because it needs no credentials.
- Rate limiting: 10 sign-ins per minute per client IP (Better Auth limiter; in production it needs the same `TRUSTED_PROXIES` setup as the other auth limits), a cap of 300 live sessions per role, and the per-session write budget above.
- A demo session may only call `/auth/get-session`, `/auth/sign-out`, `/auth/list-accounts` and `/auth/demo/sign-in`; change-password, change-email, update-user, delete-user, link-social and every session-listing/revoking route answer 403 `DEMO_RESTRICTED` (listing sessions of a *shared* identity would reveal other visitors' session tokens). Sign-in, sign-up, password-reset and code requests that name a demo address are refused or answered like an unknown address, and nothing is mailed.
- No email or SMS is sent by any demo action: the only outbound mail in the system is authentication mail, and it is suppressed for demo addresses (which are undeliverable anyway).

## 8. Simulated payments

A demo customer's booking is paid with the **`DEMO` provider** (`src/payments/providers/demo.adapter.ts`): no credentials, no network call, no money.
- `GET /payments/providers` returns only "Simulated payment (demo)" for demo sessions and only bKash for everybody else; `PaymentProviders.get()` is realm-aware, so bKash is unreachable from a demo request even if it is configured, and the simulation is unreachable from a real one.
- `POST /bookings/:id/payments {provider:"DEMO"}` creates a normal payment row (amount, currency, customer and eligibility from the database, idempotency keys, one open attempt per booking) whose "checkout" is the web app's own page `/payments/demo/<reference>`. There the visitor picks *succeeds / fails / cancelled*; `POST /payments/:reference/demo-outcome` applies it through the **same** `applyVerification` state machine and booking gate as a real payment, with a verification built entirely from the stored attempt, never from the request (strict body: only `outcome`). Only a "success" moves the booking from *payment due* to *completed*. Anyone but the demo customer who owns a `DEMO` payment gets a 404, a settled payment cannot be settled again (409).
- The database refuses a `DEMO` payment for an ordinary customer and a real-provider payment for a demo customer, and a simulated payment can never be `live`. Real payments, callbacks, idempotency and verification rules are untouched (the existing payment tests pass unchanged).
- Refunds: a demo customer follows the normal refund rules (only cancelled bookings); the `DEMO` adapter has refunds disabled and the demo administrator is read-only, so no refund can be executed. Demo payments never appear in real finance reports or the dashboard.

## 9. Concurrency, shared identities and reset (trade-offs)

The three login identities are **shared**: every visitor who clicks "Demo Customer" is the same user with its own session. I evaluated per-visitor sandboxes and rejected them: chat messages, payment events and audit rows are append-only by trigger, so a visitor's data could never be cleaned up, and every click would grow the database forever. With shared identities:
- **No leak between demo and real data** (section 5). Visitors' own actions are, however, visible to other demo visitors (a message typed into the demo chat, a review, a booking). Everything is fictional, text goes through the existing sanitisation, and writes are rate limited, but a hostile visitor can still put offensive text into the shared demo. Do not publish the demo anywhere you would not accept that; run `demo:reset` on a schedule (cron or a GitHub Action with the database URL) or after an incident.
- **Interference**: one visitor can cancel, accept or pay for the booking another is looking at, or edit the demo worker's availability. Existing database locks and idempotency keep every action consistent; nothing is corrupted, but the shared demo drifts. `demo:reset` restores it. Upcoming demo jobs are dated relative to seed time, so reset (or re-seed) after a few days.
- Session lists are blocked (a visitor must not see another's token), "log out other devices" is blocked (it would end other visitors' sessions).
- `demo:reset` is an operator action that disables the two append-only triggers for the length of one transaction. It selects rows only through `isDemo`, keeps the demo user rows (deleting them would try to detach audit rows), and is never reachable over HTTP. Measures against runaway growth until you reset: the per-session write budget, the 300-session cap, and the existing per-feature limits (open requests per customer, post throttles).

## 10. API summary

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/demo/options` | public, `no-store` | visible options: `{ role, label, description, available }[]` |
| `POST /api/v1/auth/demo/sign-in` | public, origin-checked, 10/min per IP | `{role}` → session cookie, `{ role, redirectTo }`; 400 / 403 `DEMO_DISABLED` / `INVALID_ORIGIN` / 409 `ALREADY_SIGNED_IN` / 429 / 503 `DEMO_UNAVAILABLE`, `DEMO_BUSY` |
| `GET /api/v1/me` | session | adds `demo: { role } \| null` |
| `PUT /api/v1/admin/settings/demo.<role>.(visible\|enabled)` | real admin with `settings.manage` | the switches (existing endpoint) |
| `POST /api/v1/payments/:reference/demo-outcome` | demo customer | decide a simulated payment |

## 11. Files

Backend: `prisma/migrations/20261103000000_demo_payment_provider`, `20261103010000_demo_access`; `src/demo/*` (config, guard, service/controller for the options, fixtures, reset); `src/prisma/realm.ts` and `prisma.service.ts`; `src/auth/demo-login.plugin.ts`, `auth.factory.ts` (hooks), `auth.guard.ts`, `decorators.ts` (`OptionalAuth`); `src/admin/settings/*` (registry, service, controller); `src/payments/*` (demo adapter, realm-aware providers, outcome endpoint); `scripts/demo-seed.ts`, `scripts/demo-reset.ts`. Frontend: `src/lib/demo.ts`, `src/components/auth/demo-*.tsx`, `src/app/demo/[role]`, `src/components/layout/demo-banner.tsx`, the "Demo Access Settings" section of `settings-view.tsx`, `src/components/payments/demo-checkout.tsx` and `src/app/payments/demo/[reference]`.

## 12. Verification and limitations

See the "Follow-up: demo access" section of [QA_REPORT.md](QA_REPORT.md) for the commands that were run and their results, and for what was **not** run.

Known limitations:
- Production behaviour behind Vercel (cookie flags over HTTPS, the real client IP for the sign-in rate limit via `TRUSTED_PROXIES`) is not verified; the `Secure` flag is tested only against a production-mode test app.
- The write budget is per process (a best-effort brake, not an exact quota across serverless instances); the sign-in limiter and session cap are shared (database).
- The demo drifts as visitors use it until `demo:reset` runs; there is no scheduler in the project, so scheduling the reset is up to the operator.
- The AI assistant is intentionally unavailable in the demo.
- Public-page performance: every realm-scoped query adds a join on the owning user. Not measured under load.
