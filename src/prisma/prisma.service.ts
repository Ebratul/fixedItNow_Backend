import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { ENV, type Env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

/** Single shared Prisma client using the pg driver adapter. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      // Fail fast instead of queueing forever when the pool or database is exhausted.
      connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
    });
    // A runaway query is cancelled by the server rather than holding a connection indefinitely.
    // Set once per connection with SET, awaited before the client is handed out. It is not a startup
    // parameter because poolers such as Prisma Postgres reject those ("Failed to connect to upstream
    // database"), and it is not fired from the pool's "connect" event because that would overlap the
    // caller's first query on the same client.
    const timeoutSql = `SET statement_timeout = ${Math.trunc(env.DATABASE_STATEMENT_TIMEOUT_MS)}`;
    const configured = new WeakSet<pg.PoolClient>();
    const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    const connectConfigured = async () => {
      const client = await connect();
      if (!configured.has(client)) {
        try {
          await client.query(timeoutSql);
          configured.add(client);
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
      return client;
    };
    // pg's own pool.query() calls connect(callback), so both forms must be supported.
    pool.connect = ((callback?: (error: Error | undefined, client?: pg.PoolClient, done?: (release?: unknown) => void) => void) => {
      if (!callback) return connectConfigured();
      connectConfigured().then(
        (client) => callback(undefined, client, (release) => client.release(release as boolean | undefined)),
        (error: Error) => callback(error),
      );
    }) as typeof pool.connect;
    super({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
