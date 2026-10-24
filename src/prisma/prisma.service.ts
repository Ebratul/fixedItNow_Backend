import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { ENV, type Env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

/** Single shared Prisma client using the pg driver adapter. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: env.DATABASE_POOL_MAX,
        // Fail fast instead of queueing forever when the pool or database is exhausted.
        connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
        idleTimeoutMillis: 30_000,
        // A runaway query is cancelled by the server rather than holding a connection indefinitely.
        statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      }),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
