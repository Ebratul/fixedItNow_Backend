# backend

NestJS 12 (ESM) API with Prisma 7 + PostgreSQL and Better Auth. Only backend code belongs in this
folder. See [../docs/API.md](../docs/API.md), [../docs/SECURITY.md](../docs/SECURITY.md) and
[../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

```bash
cp .env.example .env && npm install
npx prisma migrate dev && npm run db:seed
npm run start:dev          # :4000
npm run admin:grant -- you@example.com   # trusted operator action
```

| Script | What it does |
| --- | --- |
| `npm test` | Unit tests (no database) |
| `npm run test:e2e` | Integration tests against `TEST_DATABASE_URL` (name must end in `_test`) |
| `npm run typecheck` / `npm run lint` / `npm run build` | Static checks / compile |
| `npm run db:migrate` / `db:deploy` / `db:seed` | Prisma migrate (dev) / deploy (production) / seed categories |

`src/auth/` holds authentication (Better Auth factory) and **authorization** (guards, decorators,
`policies.ts`). New endpoints are authenticated by default; use `@Public()` to opt out and
`@RequireAdmin()` / `@RequireApprovedWorker()` to restrict.
