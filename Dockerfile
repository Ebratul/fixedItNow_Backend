# syntax=docker/dockerfile:1
# Two targets from one file:
#   runtime  (default): the API only, production dependencies, non-root.
#   migrate : the same code plus the Prisma CLI, used ONLY by a release job to run
#             `prisma migrate deploy` (and, on a brand-new database, the seed).
# Build from backend/:  docker build -t fixeditnow-api .  |  docker build --target migrate -t fixeditnow-migrate .

FROM node:24-slim AS build
WORKDIR /app
# openssl: required by the Prisma engines on slim images
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate`; it needs no database connection
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:24-slim AS migrate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY scripts ./scripts
RUN npm ci
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# --ignore-scripts: postinstall runs `prisma generate` (a dev tool); the generated client is already compiled into dist/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main"]
