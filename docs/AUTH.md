# Authentication

FixedItNow has two ways to sign in, both on the existing **Better Auth** setup (no provider change was needed):

1. **Continue with Google** (OAuth 2.0 authorization code + PKCE, OpenID Connect `openid email profile`).
2. **Email + password registration verified by a one-time code (OTP)**, sent by email.

Customer/Worker is chosen at onboarding after sign-in. Nobody can self-assign Admin: `role` is not an input field,
and the only way to become admin is the operator script `npm run admin:grant`.

> **Status.** Everything below is implemented and tested against a real PostgreSQL database, a stubbed Google token
> endpoint and a console mail sink (the SMTP transport itself is covered by a mocked/failing-server unit test). **Real Google login and real email delivery have not been exercised**, because
> no Google credentials or SMTP provider were available. Treat both as unverified until you run the checklist in
> [Go-live checks](#go-live-checks).

## Email verification code flow

```
register form ──POST /auth/sign-up/email──▶ user created (emailVerified=false), no session
              ◀── 200 (same answer whether or not the email already exists)
server ──sendVerificationOTP──▶ mail with a 6-digit code (no link)
code step ──POST /auth/email-otp/verify-email {email, otp, password}──▶ emailVerified=true + session cookie
```

Policy (constants in `backend/src/auth/otp.ts`):

| Rule | Value |
| --- | --- |
| Code | 6 digits from `crypto.randomInt` (CSPRNG), zero padded |
| Lifetime | 10 minutes |
| Wrong guesses | 5 per code, then the code is dead (`TOO_MANY_ATTEMPTS`) |
| Resend cooldown | 60 s per address |
| Sends per address | 5 per hour |
| Replay | A code is consumed atomically; using it twice (also in parallel) fails |
| Storage | Only an HMAC-SHA-256 of the code (key derived from `BETTER_AUTH_SECRET`) is stored; the plaintext exists only in the email |
| Logging | Codes are never logged in production. In development the console mail transport prints the message to the API terminal, nowhere else. |
| IP rate limits | `send-verification-otp`: 6 per 10 min; `verify-email`: 15 per 10 min (plus the global auth limit) |

Design decisions worth knowing:

* **The password is required to verify.** `verify-email` also checks the password against the account's stored hash.
  Someone who only knows an address (or who pre-registers a victim's address) cannot use a code that was mailed to
  the real owner to take over an account. The code step keeps email and password in memory only (never in the URL or storage).
* **Resend never reveals anything.** Unknown address, already-verified address, cooldown and hourly cap all return
  `{ "success": true }` with no mail. A blocked request does not rotate the code you already hold.
* **Only `email-verification` codes exist.** Sign-in-by-code, password-reset-by-code, email-change and the
  link-based `/verify-email` and `/send-verification-email` routes are disabled (they return 404), so there is one
  verification path to reason about.
* **Unverified login** returns `403 EMAIL_NOT_VERIFIED` only after a correct password. The login page then opens the
  code step and requests a code (subject to the cooldown, so a code you already have stays valid).
* **Verified server-side only.** `emailVerified`, `role`, `id` in a request body are ignored/rejected; the flag flips
  only inside the verify handler after a correct code.
* Throttle state lives in the existing `verification` table (identifier `otp-send:<sha256(email)>`), so there is **no migration**.

## Google flow

* Started by `POST /auth/sign-in/social` (`provider: "google"`), which returns the Google URL containing `state` and a PKCE challenge.
* The callback `GET /auth/callback/google` checks `state` against the signed state cookie and sends the PKCE verifier.
  Forged, missing, cross-browser and replayed state are rejected and redirect to the login page with `?error=`.
* Only identity scopes are requested (`openid email profile`), plus `prompt=select_account`.
* **A Google account whose email is unverified creates nothing.** (`databaseHooks.user.create.before` aborts it.)
* **No implicit account linking** (`disableImplicitLinking`, no trusted providers, `allowDifferentEmails: false`).
  If an account already exists for that email, Google sign-in is refused with `account_not_linked`; the owner logs in
  with their password and presses "Connect Google" on `/account`, which needs a session. This stops a pre-registered
  or squatted account from being merged with, or taken over via, a later Google sign-in.
* New Google users get role `USER`, `emailVerified=true` and then go through the same onboarding.

## Sessions, logout, protected routes

* Server-side sessions in PostgreSQL, 7-day expiry, no cookie cache. Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production.
* `POST /auth/sign-out` ends the current session; password reset revokes all sessions.
* The Nest API is default-deny: a global guard requires a session unless a route is explicitly public. Admin routes
  need `role=ADMIN`. Next.js pages (`/account`, `/onboarding`, dashboards) redirect to `/login?next=…` when signed out;
  `next` is accepted only if it is a same-origin path.

## Environment variables

Backend (`backend/.env`; placeholders in `backend/.env.example`):

| Variable | Needed for | Secret |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | sessions, signed state, OTP hashing; >= 32 random chars (`openssl rand -base64 48`). **Changing it invalidates outstanding codes and sessions.** | **yes** |
| `BETTER_AUTH_URL` | public **web** origin, e.g. `https://app.example.com` | no |
| `FRONTEND_ORIGIN` | same origin; origin checks | no |
| `GOOGLE_CLIENT_ID` | Google login | no |
| `GOOGLE_CLIENT_SECRET` | Google login (set both or neither) | **yes** |
| `MAIL_TRANSPORT` | `console` (dev only; refused in production) or `smtp` | no |
| `EMAIL_FROM` | sender, e.g. `FixedItNow <no-reply@your-domain>` | no |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` | SMTP server | no |
| `SMTP_USER` `SMTP_PASS` | SMTP credentials | **yes** (`SMTP_PASS`) |
| `TRUSTED_PROXIES`, `TRUST_PROXY` | correct client IP for rate limits (see DEPLOYMENT.md) | no |

Frontend (`frontend/.env.local` / Vercel project settings):

| Variable | Purpose |
| --- | --- |
| `BACKEND_URL` | Where `/api/v1/*` is proxied. **Read at build time** (it is baked into the rewrite), so changing it needs a rebuild. |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin (metadata, sitemap) |

No secret is `NEXT_PUBLIC_*`; a scan of `.next/static` for the configured secret values and for server-only OTP identifiers found none.

## Google Cloud Console

1. Create/select a project at <https://console.cloud.google.com>.
2. **APIs & Services → OAuth consent screen**: user type *External*; app name, support email, developer contact;
   authorized domain = your production domain; scopes `openid`, `email`, `profile` (all non-sensitive, so no Google verification review is needed for these alone).
   While the app is in *Testing*, only listed **test users** can sign in and refresh tokens expire; **Publish** the app for general use.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
4. **Authorized JavaScript origins**: `http://localhost:3000`, `https://YOUR-DOMAIN`.
5. **Authorized redirect URIs** (exact match, no trailing slash):
   * `http://localhost:3000/api/v1/auth/callback/google`
   * `https://YOUR-DOMAIN/api/v1/auth/callback/google` (and one per preview/staging domain you want Google on)
6. Put the client ID and secret in the **backend** environment only, restart, and confirm
   `GET /api/v1/config/auth` reports `googleEnabled: true`. The "Continue with Google" button is honest: when Google is not configured it says so instead of failing.

The redirect URI uses the **web app's** origin because the web app proxies `/api/v1/*` to the API, so the state cookie is first-party.

## Email provider requirements

* Any SMTP service (SES, Postmark, SendGrid SMTP, Mailgun, Resend SMTP, Google Workspace relay…).
* A sender on a domain you control with **SPF and DKIM** (and ideally DMARC) configured, otherwise codes land in spam.
* Port 587 with STARTTLS (`SMTP_SECURE=false`) or 465 (`SMTP_SECURE=true`).
* Transactional stream/low latency: codes expire in 10 minutes and the resend cooldown is 60 s.
* The send must be allowed to finish after the response. Request handlers call `MailService.sendInBackground`, which
  starts the send without delaying the response (no timing side channel) and registers it with `waitUntil` from
  `@vercel/functions`, so a Vercel Function stays alive until the SMTP conversation ends. Outside Vercel `waitUntil`
  is a no-op and the long-running server simply finishes the promise. (Before this, a bare `void mail.send(...)` meant
  the production function on Vercel was frozen as soon as the response was written: reset and verification emails never left.)
* **Gmail SMTP**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER` = the full Gmail
  address, `SMTP_PASS` = a 16-character **App Password** (needs 2-Step Verification; a normal account password is
  refused with `535 5.7.8`). `EMAIL_FROM` should use the same address. The API logs a start-up warning when
  `SMTP_USER`/`SMTP_PASS` look swapped, and logs `Failed to send <kind> email: <provider error>` (never the body or
  recipient) when the provider rejects a message.

## Vercel setup

Production runs as three Vercel projects deployed from their own directories with the CLI
(`cd frontend && vercel deploy --prod`, same for `backend/` and `rag_agent/`). The API runs as one Vercel Function
(`backend/api/index.mjs`, see `backend/scripts/bundle-vercel.mjs`).

1. **Web project** (`frontend/`): `BACKEND_URL` (the API's URL; **build time**, baked into the `/api/v1/*` rewrite) and
   `NEXT_PUBLIC_SITE_URL` (the public web origin).
2. **API project** (`backend/`): all backend variables above. `BETTER_AUTH_URL` and `FRONTEND_ORIGIN` are the **web**
   origin (the browser only ever talks to it, so cookies stay first-party and `SameSite=Lax` works).
3. Variables are read when the function boots. **Adding or changing one does nothing until the project is redeployed**
   (Google stayed off in production for exactly this reason: the Google variables were added after the last deploy).
   Check with `GET /api/v1/config/auth` → `googleEnabled`.
4. Google redirect URI: `<BETTER_AUTH_URL>/api/v1/auth/callback/google`, registered exactly in Google Cloud Console.
   Preview deployments get new domains, so either skip Google on previews or register them.
5. All variables are currently scoped to **Production** only, so a Preview deployment of the API cannot start.
6. The web project is connected to the GitHub repo with Root Directory `.`, so pushes used to start a production build
   of the repository root, which fails (no `app` directory). The root `vercel.json` turns those Git deployments off;
   remove it (and set the project's Root Directory to `frontend`) if you want push-to-deploy instead of CLI deploys.
7. Client IP: see `TRUSTED_PROXIES` in DEPLOYMENT.md. **Not verified on Vercel.** The per-address OTP cooldown, hourly
   cap and five-guess limit do not depend on the IP.

## Migration steps

None. This change adds no table or column; it reuses the existing `verification` table. (`npx prisma migrate deploy`
stays part of the normal release procedure.) Users who registered under the old link flow and are still unverified
can verify by logging in; the login page requests a code.

## Tests

| Layer | File | What it covers |
| --- | --- | --- |
| Unit | `backend/src/auth/otp.spec.ts` | generator format/distribution, keyed hasher, throttle logic |
| Integration | `backend/test/email-otp.e2e-spec.ts` | send, hashed storage, success + cookie flags, replay, parallel verify, attempt exhaustion, expiry, malformed input, client-supplied `emailVerified`/`role`/`id`, cross-address code use, pre-hijack and password binding, cooldown/hourly cap/type restriction, disabled routes, IP rate limits, unverified login |
| Integration | `backend/test/google-login.e2e-spec.ts` | success with PKCE, forged/cross-browser/missing/replayed state, denied consent, failed token exchange, unverified Google email, no implicit linking, pre-hijack, link needs a session, scopes. The Google token endpoint is **stubbed**. |
| Component | `frontend/src/__tests__/auth-forms.test.tsx` | register → code step, login → code step, resend cooldown, error mapping, no navigation before success |
| Browser | `frontend/e2e/auth-otp.mjs` | real Chrome: sign-up, wrong/correct/pasted code, replay, unverified-login path, standalone verify page, OAuth error text, protected-route redirect, axe + overflow at 5 widths |

Run the browser journey with the API started with `MAIL_TRANSPORT=console` and its output captured to a file:
`QA_BASE=http://localhost:3000 QA_BACKEND_LOG=/path/to/api.log node frontend/e2e/auth-otp.mjs` (see `frontend/e2e/README.md`).

## Go-live checks

Not done here, because they need real credentials:

1. Set Google credentials, log in with a real Google account (new user and returning user), and confirm an existing password account gets `account_not_linked`.
2. Configure SMTP, register with a mailbox you control, and confirm the code arrives (inbox, not spam), works once, and expires.
3. Confirm on the deployed stack that `X-Forwarded-For` reaches the API as the real client IP (hit the send endpoint 7 times from one IP and expect `429`).
4. Confirm cookies are `Secure; HttpOnly; SameSite=Lax` in the browser's dev tools on the production domain.
