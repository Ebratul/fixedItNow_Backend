import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("operations: request ids, health, error handling, admin status", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ HTTP_LOG: "true" }); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  describe("request ids and access log", () => {
    it("returns an X-Request-Id on every response, echoing only safe inbound ids", async () => {
      const minted = await t.client().get(`${t.api}/categories`);
      expect(minted.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
      const echoed = await t.client().get(`${t.api}/categories`).set("X-Request-Id", "trace-abc-12345678");
      expect(echoed.headers["x-request-id"]).toBe("trace-abc-12345678");
      for (const bad of ["short", "has space in it 123456", "x".repeat(100), "inj\\nected-log-line-1"]) {
        const res = await t.client().get(`${t.api}/categories`).set("X-Request-Id", bad);
        expect(res.headers["x-request-id"]).not.toBe(bad);
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
      }
      expect((await t.client().get(`${t.api}/nope-route`)).headers["x-request-id"]).toBeTruthy(); // 404s too
    });

    it("logs one JSON line per request with the route template, never the query string, ids or bodies", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
      try {
        const user = await t.signUpAndLogin("ops-log@example.com");
        await t.client().get(`${t.api}/payments/callbacks/bkash/FIN0123456789abcdef01234567?paymentID=SECRETPAY&status=success&signature=SECRETSIG`);
        await user.agent.post(`${t.api}/community/posts`).send({ title: "Private title here", body: "private body text" });
        await t.client().get(`${t.api}/health/ready`);
      } finally {
        spy.mockRestore();
      }
      const records = lines.flatMap((l) => l.split("\n")).filter((l) => l.startsWith('{"event":"http"')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(records.length).toBeGreaterThan(2);
      const callback = records.find((r) => String(r.route).includes("callbacks/bkash"))!;
      expect(callback).toMatchObject({ method: "GET", route: "/api/v1/payments/callbacks/bkash/:reference", status: 303, requestId: expect.any(String), ms: expect.any(Number) });
      const everything = lines.join("");
      for (const secret of ["SECRETPAY", "SECRETSIG", "FIN0123456789abcdef01234567", "Private title", "private body", "ops-log@example.com", "cookie"]) {
        expect(everything, secret).not.toContain(secret);
      }
      expect(records.some((r) => String(r.route).includes("health"))).toBe(false); // probes are not logged
    });
  });

  describe("health", () => {
    it("liveness is dependency-free; readiness checks the database and reveals nothing else", async () => {
      expect((await t.client().get(`${t.api}/health/live`)).body).toEqual({ status: "ok" });
      for (const path of ["/health", "/health/ready"]) {
        const res = await t.client().get(`${t.api}${path}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: "ok", checks: { database: "ok" } });
      }
    });

    it("readiness fails with a bare 503 when the database is unavailable, liveness still answers", async () => {
      const spy = vi.spyOn(t.prisma, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2"));
      try {
        const res = await t.client().get(`${t.api}/health/ready`);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ checks: { database: "unavailable" } });
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|hunter2|password/);
        expect((await t.client().get(`${t.api}/health/live`)).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("unexpected errors", () => {
    it("return a generic 500 with the request id, and log only a safe summary", async () => {
      const spy = vi.spyOn(t.prisma.serviceCategory, "findMany").mockRejectedValue(
        Object.assign(new Error("Invalid `prisma.x()` invocation: password=hunter2 postgres://u:p@db:5432/x"), { code: "P2010" }),
      );
      const written: string[] = [];
      const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      try {
        const res = await t.client().get(`${t.api}/categories`).set("X-Request-Id", "req-for-support-1");
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ statusCode: 500, error: "Internal Server Error", message: "Internal server error", requestId: "req-for-support-1" });
        const log = written.join("");
        expect(log).toContain('"event":"unhandled_error"');
        expect(log).toContain("req-for-support-1");
        expect(log).toContain("P2010");
        expect(log).not.toMatch(/hunter2|postgres:\/\/|Invalid `prisma/);
      } finally {
        spy.mockRestore();
        err.mockRestore();
      }
    });

    it("keeps 4xx status for body-parser errors and never echoes the input", async () => {
      const huge = await t.client().post(`${t.api}/community/posts`).send({ title: "x", body: "y".repeat(300_000) });
      expect(huge.status).toBe(413);
      expect(huge.body).toMatchObject({ statusCode: 413, message: "Request body too large" });
      const malformed = await t.client().post(`${t.api}/community/posts`).set("content-type", "application/json").send('{"title": "SECRET-IN-BODY", ');
      expect(malformed.status).toBe(400);
      expect(JSON.stringify(malformed.body)).not.toContain("SECRET-IN-BODY");
    });

    it("leaves ordinary HTTP errors (validation, 404, 401) exactly as before", async () => {
      expect((await t.client().get(`${t.api}/workers?pageSize=999`)).body).toMatchObject({ statusCode: 400, message: "Validation failed" });
      expect((await t.client().get(`${t.api}/workers/nope`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/me`)).status).toBe(401);
    });
  });

  describe("GET /admin/ops/status", () => {
    it("is admin-only", async () => {
      const user = await t.signUpAndLogin("ops-user@example.com");
      expect((await t.client().get(`${t.api}/admin/ops/status`)).status).toBe(401);
      expect((await user.agent.get(`${t.api}/admin/ops/status`)).status).toBe(403);
    });

    it("reports dependency state and work queues from stored rows, without secrets", async () => {
      const admin = await t.newAdmin();
      const res = await admin.agent.get(`${t.api}/admin/ops/status`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        database: "ok",
        ai: { configured: false },
        payments: { bkash: "not_configured", refundsEnabled: { bkash: false } },
        mail: "console",
        queues: { paymentsRequiringReview: 0, paymentsUnresolvedOver30Minutes: 0, refundsAwaitingProvider: 0, refundsAwaitingDecision: 0, disputesOpen: 0, reportsOpen: 0 },
      });
      const text = JSON.stringify(res.body);
      for (const secret of [t.env.BETTER_AUTH_SECRET, t.env.DATABASE_URL, "localhost:3000"]) expect(text).not.toContain(secret);
    });
  });
});
