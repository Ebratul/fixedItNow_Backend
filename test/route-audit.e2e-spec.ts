import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestApp, WEB_ORIGIN, type TestApp } from "./helpers.js";

/**
 * DEFAULT-DENY AUDIT. Walks the router of the real running app and calls EVERY
 * route with no session. Anything not on the explicit public list below must
 * answer 401. Adding a route that is public by accident now fails this test:
 * a new public route must be added here on purpose, in review.
 */
const PUBLIC = new Set([
  "GET /api/v1/health", "GET /api/v1/health/ready", "GET /api/v1/health/live", "GET /api/v1/config/auth",
  "GET /api/v1/categories", "GET /api/v1/categories/:slug",
  "GET /api/v1/workers", "GET /api/v1/workers/:slug", "GET /api/v1/workers/:slug/availability", "GET /api/v1/workers/:slug/reviews",
  "GET /api/v1/ai/status",
  // provider callbacks: untrusted input, verified server-to-server (see docs/PAYMENTS.md)
  "GET /api/v1/payments/callbacks/bkash/:reference", "POST /api/v1/payments/callbacks/sslcommerz/:kind", "POST /api/v1/payments/ipn/sslcommerz",
  // service-to-service: guarded by ServiceTokenGuard (404 when unconfigured, 401 without the token)
  "GET /api/v1/internal/ai/workers", "GET /api/v1/internal/ai/categories",
]);
const AUTH_PREFIX = "/api/v1/auth/"; // Better Auth owns these (its own rate limits, origin and CSRF checks)

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

describe("route audit (default deny)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  const routes = () => {
    const stack = ((t.app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } }).router.stack ?? []);
    const out: { method: string; path: string }[] = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
    return out;
  };

  it("finds the application's routes", () => {
    expect(routes().length).toBeGreaterThan(100);
  });

  it("answers 401 to every non-public route when no session is sent", async () => {
    const offenders: string[] = [];
    for (const { method, path } of routes()) {
      if (path.startsWith(AUTH_PREFIX) || path.includes("splat")) continue;
      if (PUBLIC.has(`${method} ${path}`)) continue;
      const url = path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000");
      const req = request(t.app.getHttpServer())[method.toLowerCase() as "get"](url).set("Origin", WEB_ORIGIN);
      const res = await req.send(method === "GET" ? undefined : {});
      if (res.status !== 401) offenders.push(`${method} ${path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every public route is on the reviewed list (nothing unexpectedly public)", () => {
    const actual = new Set(routes().map((r) => `${r.method} ${r.path}`));
    for (const entry of PUBLIC) expect(actual.has(entry), `${entry} no longer exists: update the audit list`).toBe(true);
  });

  it("admin and service routes refuse an ordinary signed-in user", async () => {
    const user = await t.signUpAndLogin("route-audit@example.com");
    const offenders: string[] = [];
    for (const { method, path } of routes()) {
      if (!path.startsWith("/api/v1/admin/") && !path.startsWith("/api/v1/internal/")) continue;
      const url = path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000");
      const res = await (user.agent as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number }> }>)[method.toLowerCase()]!(url).send(method === "GET" ? undefined : {});
      if (![401, 403, 404].includes(res.status)) offenders.push(`${method} ${path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("is not readable cross-origin: no CORS allowance is ever granted", async () => {
    for (const path of ["/workers", "/categories", "/health/ready"]) {
      const res = await t.client().get(`${t.api}${path}`).set("Origin", "https://evil.example");
      expect(res.headers["access-control-allow-origin"], path).toBeUndefined();
    }
    const preflight = await request(t.app.getHttpServer()).options(`${t.api}/community/posts`).set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends the standard security headers and does not advertise the framework", async () => {
    const res = await t.client().get(`${t.api}/categories`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
