import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * The data realm of the current request (docs/DEMO.md). Demo accounts live in the "demo" realm and everyone else in
 * "real"; PrismaService filters every query by it, so a demo session only ever sees demo rows and an ordinary session
 * never sees them. It is decided ONLY by the authentication guard from the database (never by the client) and
 * defaults to "real" outside a request (scripts, tests), which hides demo rows rather than exposing them.
 */
export type Realm = "real" | "demo";

type RequestStore = { requestId: string; realm?: Realm };

/** Per-request context, readable anywhere in the call chain (e.g. to correlate with the AI service). */
export const requestContext = new AsyncLocalStorage<RequestStore>();
export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;
export const currentRealm = (): Realm => requestContext.getStore()?.realm ?? "real";

/** Sets the realm of the current request. Returns false when there is no request context to hold it. */
export function enterRealm(realm: Realm): boolean {
  const store = requestContext.getStore();
  if (!store) return false;
  store.realm = realm;
  return true;
}

/**
 * Runs `fn` with the given realm (the demo fixtures, tests). It awaits inside the context on purpose: a Prisma query is lazy
 * and only starts when something awaits it, so a promise returned out of the context would run in the caller's realm.
 */
export async function runInRealm<T>(realm: Realm, fn: () => Promise<T> | T): Promise<T> {
  return requestContext.run({ requestId: currentRequestId() ?? "", realm }, async () => await fn());
}

/** An inbound id is trusted only if it is a short, harmless token (no log injection); otherwise we mint one. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Assigns `X-Request-Id`, and writes ONE JSON access-log line per request:
 * method, route TEMPLATE (e.g. /api/v1/bookings/:id), status, duration, id.
 * Never logged: query strings (provider callbacks carry tokens there), bodies,
 * headers, cookies, user ids, or concrete path values.
 */
export function requestLogger(options: { log: boolean; write?: (line: string) => void }) {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers["x-request-id"];
    const requestId = typeof inbound === "string" && SAFE_ID.test(inbound) ? inbound : randomUUID().replaceAll("-", "");
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    if (options.log) {
      res.on("finish", () => {
        const route = (req.route as { path?: string } | undefined)?.path;
        if (route && /\/health(\/live|\/ready)?$/.test(route)) return; // probes are noise
        write(
          JSON.stringify({
            event: "http",
            requestId,
            method: req.method,
            route: route ?? "unmatched",
            status: res.statusCode,
            ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          }),
        );
      });
    }
    requestContext.run({ requestId }, next);
  };
}
