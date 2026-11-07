<div align="center">

# 🛠️ FixedItNow

**A Bangladesh-focused marketplace that connects customers with trusted local service professionals.**

Find a verified electrician, plumber, cleaner or technician, book them, chat, pay with bKash and review the work, all in one place.

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-Python%203.12-009688?logo=fastapi&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)

### 🌐 [Live demo: fixeditnowwithragagent-web.vercel.app](https://fixeditnowwithragagent-web.vercel.app)

[Requirements](SRS.md) · [Architecture](ARCHITECTURE.md) · [API](API.md) · [Deployment](DEPLOYMENT.md) · [Audit](AUDIT.md)

</div>

---

## ✨ Features

| Area | What you get |
| --- | --- |
| 🔐 **Accounts** | Email + password, email + one-time code, Google sign-in, email verification, password reset ([AUTH](AUTH.md)) |
| 🧑‍🔧 **Professionals** | Worker onboarding, admin approval, public profiles, service categories, searchable directory with filters, favourites |
| 📅 **Bookings** | Booking requests, quotes, worker availability, rescheduling, cancellation, disputes ([BOOKINGS](BOOKINGS.md)) |
| 🔄 **Full job lifecycle** | Booking → in-app chat → arrival → payment gate → review ([WORKFLOW](WORKFLOW.md)) |
| 💳 **Payments** | bKash and SSLCOMMERZ integrations, payment verification, append-only transaction records, refund workflow ([PAYMENTS](PAYMENTS.md)) |
| ⭐ **Reviews & community** | One review per completed and paid booking, posts, comments, likes, reports, feature proposals and voting ([COMMUNITY](COMMUNITY.md)) |
| 🤖 **AI assistant** | Describe a need in plain language at `/assistant`; a separate Python service turns it into filters and the API returns real, database-verified professionals ([AI](AI.md)) |
| 🛡️ **Admin panel** | Roles and granular permissions, user / worker / booking / payment / support / content management, AI knowledge base, tamper-evident audit log ([ADMIN](ADMIN.md)) |
| 🎭 **Explore Demo** | "Continue as Demo Customer / Worker / Admin" on the login page, no sign-up; admin-controlled per-role visibility and availability, isolated fictional data, read-only Demo Admin, simulated payments ([DEMO](DEMO.md)) |

## 🏗️ Architecture

```
                    ┌──────────────────────┐
   Browser  ───────▶│  frontend  (Next.js) │
                    └──────────┬───────────┘
                               │  /api/v1/*  (proxied)
                    ┌──────────▼───────────┐        ┌─────────────────────┐
                    │  backend (NestJS 12) │───────▶│ rag_agent (FastAPI) │
                    │  Prisma · Better Auth│        │ intent + knowledge  │
                    └──────────┬───────────┘        └─────────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │     PostgreSQL       │
                    └──────────────────────┘
```

The AI service never touches the database and is never called by browsers. It only extracts intent and phrases answers from curated knowledge; the API re-reads workers from PostgreSQL before showing anything.

### Tech stack

| Layer | Technology |
| --- | --- |
| Web | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS |
| API | NestJS 12, Prisma 7, Zod validation, Helmet, rate limiting |
| Auth | Better Auth (server-side sessions in PostgreSQL, Google OAuth, email OTP) |
| Database | PostgreSQL 16 (exclusion constraints prevent double-booking; append-only audit tables) |
| AI | FastAPI (Python 3.12), optional OpenRouter model, optional Pinecone for the knowledge base |
| Payments | bKash, SSLCOMMERZ |
| Testing | Vitest, pytest, real-Chrome end-to-end checks with axe accessibility audits |

### User roles

| Role | Can do |
| --- | --- |
| **Visitor** | Browse services, professionals and public profiles |
| **Customer** | Search, favourite, book, chat, pay, review, report content |
| **Worker** | Build a profile, set availability, send quotes, manage bookings (visible only after admin approval) |
| **Admin** | Approve workers, moderate content, manage payments, support and the AI knowledge base, with granular permissions |

One account can be both a customer and a worker. Admin rights can only be granted from the server with `npm run admin:grant`, never through the API.

### Repository layout

The project is split into three repositories. Clone them side by side as `frontend`, `backend` and `rag_agent` (the staging `docker-compose` and two backend contract tests look for the sibling folders):

| Repository | Contents |
| --- | --- |
| [`fixedItNow_frontend`](https://github.com/Ebratul/fixedItNow_frontend) | Next.js web application: public site, dashboards, assistant, admin UI |
| [`fixedItNow_Backend`](https://github.com/Ebratul/fixedItNow_Backend) | Main API: NestJS 12, Prisma 7, PostgreSQL, Better Auth, plus the project docs in [`docs/`](.) |
| [`FixedItNow_RAG`](https://github.com/Ebratul/FixedItNow_RAG) | AI assistant service: FastAPI, intent extraction, curated-knowledge retrieval, safe search tool |

Each repository has its own CI workflow in `.github/workflows/ci.yml`.

```bash
git clone https://github.com/Ebratul/fixedItNow_frontend.git frontend
git clone https://github.com/Ebratul/fixedItNow_Backend.git backend
git clone https://github.com/Ebratul/FixedItNow_RAG.git rag_agent
```

## 🚀 Getting started

**Requirements:** Node 24, PostgreSQL 16+ (Docker optional), Python 3.12+ (only for the AI service).

```bash
# 1. Database + backend
cd backend
docker compose up -d db              # or use your own PostgreSQL
cp .env.example .env                 # set BETTER_AUTH_SECRET (openssl rand -base64 32)
npm install
npx prisma migrate dev
npm run db:seed
npm run start:dev                    # http://localhost:4000

# 2. Frontend (new terminal)
cd frontend
cp .env.example .env.local
npm install
npm run dev                          # http://localhost:3000

# 3. AI assistant (optional, new terminal)
cd rag_agent
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env                 # set the service tokens; OPENROUTER_* is optional
set -a; . ./.env; set +a; .venv/bin/python -m app
```

In development the email verification code and password-reset links are printed in the backend terminal. All environment variables and Google OAuth setup are in [docs/DEPLOYMENT.md](DEPLOYMENT.md). Without OpenRouter credentials the AI service runs in a rule-based "simple mode".

To try the public demo: `npm run demo:seed` (in `backend`), then switch the options on in Admin → Platform settings → Demo Access Settings ([docs/DEMO.md](DEMO.md)). Demo access is off by default.

## ✅ Checks

| Where | Commands |
| --- | --- |
| `frontend/` | `npm run lint` · `npm run typecheck` · `npm test` |
| `backend/` | `npm run lint` · `npm run typecheck` · `npm test` · `npm run test:e2e` (needs a disposable `*_test` database) |
| `rag_agent/` | `pytest` · `ruff check .` · `mypy` · `python -m evals.run_eval` |

CI runs these in each repository's `.github/workflows/ci.yml`.

## 🔒 Security highlights

- Passwords hashed with scrypt; sessions are `HttpOnly` cookies backed by the database, so revoking one takes effect immediately.
- Default-deny authentication guard, roles read from the database on every request, and strict schemas that reject unexpected fields (IDOR protection).
- Identical responses for known and unknown emails (no account enumeration), Google sign-in with state and PKCE, origin checks on unsafe requests.
- Server-side Zod validation everywhere, Helmet headers, rate limiting, and a tamper-evident audit log.

Full details: [docs/SECURITY.md](SECURITY.md).

## 📍 Project status

The project is **ready for staging, not for production** (see [docs/AUDIT.md](AUDIT.md)).

**Built and tested:** public site, accounts and onboarding, discovery, bookings, payments, chat and in-app notifications, reviews, community and moderation, AI assistant, admin panel, container images and a CI workflow.

**Not verified against the real services** (no credentials were available; everything is tested against mocks or sandboxes):

- bKash and SSLCOMMERZ payments (bKash was only exercised in its sandbox by hand)
- Google sign-in and real SMTP email delivery
- OpenRouter / a real language model for the AI assistant

**Not built yet:** worker payouts, email/SMS notifications (notifications are in-app only), Terms of Service and Privacy Policy (no approved legal text exists, so none is invented).

## 🚢 Deployment

The web app is live at **https://fixeditnowwithragagent-web.vercel.app**. The three services are deployable as separate projects (for example on Vercel) or as containers. Dockerfiles, a disposable staging stack and a runbook for deployment, backup/restore, rollback and incident handling are provided: [docs/RUNBOOK.md](RUNBOOK.md) and [docs/DEPLOYMENT.md](DEPLOYMENT.md). Behind a reverse proxy, set `TRUSTED_PROXIES` so rate limiting sees real client IPs ([docs/SECURITY.md](SECURITY.md)).

## 📚 Documentation

[SRS](SRS.md) · [ARCHITECTURE](ARCHITECTURE.md) · [API](API.md) · [AUTH](AUTH.md) · [BOOKINGS](BOOKINGS.md) · [WORKFLOW](WORKFLOW.md) · [PAYMENTS](PAYMENTS.md) · [COMMUNITY](COMMUNITY.md) · [AI](AI.md) · [ADMIN](ADMIN.md) · [SECURITY](SECURITY.md) · [DEPLOYMENT](DEPLOYMENT.md) · [RUNBOOK](RUNBOOK.md) · [AUDIT](AUDIT.md) · [QA_REPORT](QA_REPORT.md) · [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)

## 🤝 Contributing

Keep each folder to its own code (`frontend/`, `backend/`, `rag_agent/`), run the checks above before opening a pull request, and never commit `.env` files or real credentials.
