# Local performance-testing stack

A permanent local copy of the app for measuring performance on realistic data volume. It runs **next to** the
everyday dev stack and never touches it or the remote database in `backend/.env`.

| Part | Port | Started with | Config |
| --- | --- | --- | --- |
| PostgreSQL 17 (Docker, named volume `fixeditnow_perf_pg`) | 127.0.0.1:5455 | `npm run perf:db:up` (backend) | `backend/docker-compose.perf.yml` |
| API (compiled to `backend/dist-perf/`, not `dist/`) | 4100 | `npm run perf:start` (backend) | `backend/.env.perf` (only this file is loaded) |
| Web app (production build) | 3100 | `npm run start:perf` (frontend) | `frontend/.env.perf` (`BACKEND_URL=http://localhost:4100`) |
| Web app (dev mode, hot reload) | 3101 | `npm run dev:perf` (frontend) | same `frontend/.env.perf`, `NEXT_PUBLIC_SITE_URL` set to :3101 |

The everyday dev stack stays on 3000 (web) / 4000 (API) with `.env`.

**`dev:perf` and the everyday `npm run dev` cannot run at the same time.** Next 16 allows one `next dev` per project
folder (lock file `.next/dev/lock`; the second one exits with "Another next dev server is already running"). Stop
the :3000 dev server before `npm run dev:perf`, and stop `dev:perf` before going back to `npm run dev`. The
production perf web app (:3100) is not affected and can run next to either. Use :3100 for measurements; dev mode is
for working against the seeded data (it is slower and unminified by design).

Both perf web apps can sign in: `.env.perf` sets `FRONTEND_ORIGIN=http://localhost:3100` and
`EXTRA_TRUSTED_ORIGINS=http://localhost:3101` (the API accepts state-changing requests, sign-in and demo sign-in from
both). Links in emails and payment return URLs use `FRONTEND_ORIGIN` (:3100).

**Why Docker and not `npx prisma dev`:** Prisma 7.10's `prisma dev` (PGlite) applied the migrations, but it serves one
connection at a time. While one transaction was open, every other connection waited more than 5 s, and 10 parallel
queries took 485 ms (48 ms on real PostgreSQL). The API runs queries in parallel and uses transactions, so timings
measured on it would be wrong.

## First-time setup (once)

```bash
# 1. backend env (only needed if backend/.env.perf does not exist yet)
cd backend
cp .env.perf.example .env.perf
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" .env.perf
sed -i "s|^DOCUMENT_ENCRYPTION_KEY=.*|DOCUMENT_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')|" .env.perf

# 2. database: start, migrate, reference + demo seed, performance seed
npm run perf:db:up
npm run perf:db:migrate
npm run perf:db:seed
npm run perf:seed

# 3. API (keep this terminal open)
npm run perf:build
npm run perf:start

# 4. web app, in a second terminal (keep it open; the API must be running for the build)
cd frontend
cp .env.perf.example .env.perf     # only if missing
npm run build:perf
npm run start:perf
```

Then enable the demo admin once (it is off by default, and the switch is stored in the database, so this survives
restarts): open http://localhost:3100/admin, sign in as the built-in administrator **admin@rentnest.com / admin123**
(created by the API at startup), go to **Admin > Platform settings > Demo Access Settings**, and turn on
*Demo Admin: show on the login page* and *allow new demo sessions*. After that, http://localhost:3100/demo/admin
signs in as the demo administrator.

## Every day after that

```bash
cd backend && npm run perf:db:up && npm run perf:start      # terminal 1 (perf:db:up is a no-op if it is already running)
cd frontend && npm run start:perf                           # terminal 2
```

Rebuild only after code changes: `npm run perf:build` (backend) and `npm run build:perf` (frontend; also after
changing `BACKEND_URL`, which is baked into the build).

## Which login sees which data

- **admin@rentnest.com / admin123** (real realm, super admin) sees the performance data: about 1,500 users,
  1,500 bookings, 2,000 audit entries, 60 days of payments in Financial reports. **Use this account for
  measurements.**
- **/demo/admin** (demo realm, read-only) sees only the 11 fictional demo accounts and their records. The realm
  firewall keeps the demo realm and the real realm apart, so the performance data is never visible there.

## Stop, reset, remove

```bash
# stop the servers: Ctrl+C in their terminals
cd backend
npm run perf:db:down                                   # stop the database, KEEP the data
npm run perf:clean                                     # remove only the performance data (see scripts/clean-perf.ts)
npm run perf:seed                                      # ... and seed it again
docker compose -f docker-compose.perf.yml down -v      # delete the database and ALL its data
```

## Notes

- All perf scripts set `DOTENV_CONFIG_PATH=.env.perf`, so `.env` (remote database, SMTP, bKash, Google, AI) is never
  read. `perf:seed` / `perf:clean` also refuse any non-local database host.
- Rate limiting is off in `.env.perf` so a load test from one machine measures the API, not 429 responses.
- Mail is printed to the API terminal (`MAIL_TRANSPORT=console`). bKash, Google sign-in and the AI assistant are
  not configured, so those features answer "not available".
- Each API request logs one JSON line with its duration (`HTTP_LOG=true`).
- Record every optimization in `docs/performance/CHANGELOG.md` of the frontend repository (fixedItNow_frontend),
  next to the reports (`docs/performance/before/`, `bottlenecks.md`).
