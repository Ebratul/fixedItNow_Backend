import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Per-request context, readable anywhere in the call chain (e.g. to correlate with the AI service). */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;

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
