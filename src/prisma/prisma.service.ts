import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { ENV, type Env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { realmFirewall } from "./realm.js";

/**
 * Single shared Prisma client using the pg driver adapter.
 *
 * What Nest injects is the client WITH the realm firewall (src/prisma/realm.ts): every query is limited to the
 * current request's realm, so demo accounts and ordinary accounts can never see each other's rows. `unscoped` is the
 * same connection pool without the firewall; use it only where a request must look across realms by design
 * (authentication itself, the demo seed/reset, and tests).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  /** The same client without the realm firewall. Deliberately awkward to reach for: see the class comment. */
  declare readonly unscoped: PrismaClient;

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
    super({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
      // Prisma's default maxWait is 2 s, which a cold instance (new TLS connection to a remote pooler plus the SET above)
      // can exceed on its first request, failing it with P2028. Wait as long as the connect timeout instead.
      transactionOptions: { maxWait: env.DATABASE_CONNECT_TIMEOUT_MS, timeout: env.DATABASE_STATEMENT_TIMEOUT_MS },
    });
    // Returning an object from a constructor replaces the instance: the injected service IS the firewalled client
    // (it keeps this class's methods through the prototype chain, so onModuleDestroy below still runs).
    const scoped = this.$extends(realmFirewall());
    Object.defineProperty(scoped, "unscoped", { value: this as PrismaClient, enumerable: false });
    return scoped as unknown as PrismaService;
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
