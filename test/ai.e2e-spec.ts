import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiClientError, type AiCallContext } from "../src/ai/ai-client.js";
import { AiRateLimiter } from "../src/ai/ai-rate-limiter.js";
import { createTestApp, type TestApp } from "./helpers.js";

const AI = {
  AI_SERVICE_URL: "http://ai.test:8000",
  AI_SERVICE_TOKEN: "s".repeat(40),
  APP_API_SERVICE_TOKEN: "t".repeat(40),
  AI_RATE_LIMIT_PER_MINUTE: "3",
};

/** Stands in for the Python service: scripted replies, records what it was sent. */
class FakeAi {
  calls: { body: any; ctx: AiCallContext }[] = [];
  reply: (body: any) => unknown = () => {
    throw new Error("no reply scripted");
  };
  async chat(body: unknown, ctx: AiCallContext) {
    this.calls.push({ body, ctx });
    return this.reply(body);
  }
}

const intent = (extra: Record<string, unknown> = {}) => ({ category: "electrical", ...extra });
const response = (recommendations: any[], extra: Record<string, unknown> = {}) => ({
  kind: "results",
  message: "I found some professionals.",
  language: "en",
  intent: intent(),
  intentSources: { category: "explicit" },
  clarification: null,
  recommendations,
  total: recommendations.length,
  relaxations: [],
  answer: null,
  notes: [],
  mode: "llm",
  ...extra,
});
const ref = (workerId: string, rank = 1) => ({ workerId, slug: "x", rank, matchedOn: ["CATEGORY"] });

describe("AI assistant (main API side)", () => {
  const fake = new FakeAi();
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp(AI, { aiClient: fake });
  });
  afterAll(() => t.close());
  // A fresh rate-limit window (the limiter is in-memory and per process).
  const resetLimiter = () => (t.app.get(AiRateLimiter) as unknown as { hits: Map<string, number[]> }).hits.clear();
  beforeEach(async () => {
    await t.resetData();
    fake.calls = [];
    resetLimiter();
  });

  const post = (agent: any, body: unknown) => agent.post(`${t.api}/ai/chat`).send(body);

  describe("access and input", () => {
    it("needs a session; the status route is public and reveals only availability", async () => {
      expect((await t.client().post(`${t.api}/ai/chat`).send({ message: "hi" })).status).toBe(401);
      const status = await t.client().get(`${t.api}/ai/status`);
      expect(status.body).toEqual({ available: true });
    });

    it("is not CSRF-able: a cross-origin POST is rejected", async () => {
      const user = await t.signUpAndLogin("csrf@example.com");
      const res = await user.agent.post(`${t.api}/ai/chat`).set("Origin", "https://evil.example").send({ message: "hi" });
      expect(res.status).toBe(403);
      expect(fake.calls).toHaveLength(0);
    });

    it("rejects a client-supplied user id and every unknown field", async () => {
      const user = await t.signUpAndLogin("strict@example.com");
      for (const body of [
        { message: "hi", userId: "someone-else" },
        { message: "hi", history: [{ role: "system", content: "x" }] },
        { message: "hi", intent: { userId: "1" } },
        { message: "hi", intent: { category: "a b" } },
        { message: "hi", intent: { location: "Mars" } },
        { message: "" },
        { message: "x".repeat(1001) },
        { message: 5 },
      ]) {
        expect((await post(user.agent, body)).status).toBe(400);
      }
      expect(fake.calls).toHaveLength(0);
    });

    it("sends the AI service only the validated request plus a hashed subject, never the raw user id or email", async () => {
      const user = await t.signUpAndLogin("who@example.com");
      fake.reply = () => response([]);
      await post(user.agent, { message: "electrician", intent: { location: "Dhaka" } });
      const [call] = fake.calls;
      expect(call!.body).toEqual({ message: "electrician", intent: { location: "Dhaka" }, locale: "auto", action: "message" });
      expect(call!.ctx.subject).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(call)).not.toContain(user.userId);
      expect(JSON.stringify(call)).not.toContain("who@example.com");
    });
  });

  describe("grounding: the database, not the AI, decides what is shown", () => {
    it("returns fresh public cards for eligible, matching workers in the AI's rank order", async () => {
      const admin = await t.newAdmin();
      const a = await t.createWorker({ admin });
      const b = await t.createWorker({ admin, displayName: "Karim Mia" });
      const user = await t.signUpAndLogin("cust@example.com");
      fake.reply = () => response([ref(b.profileId, 2), ref(a.profileId, 1)]);
      const res = await post(user.agent, { message: "electrician" });
      expect(res.status).toBe(200);
      expect(res.body.recommendations.map((r: any) => r.worker.id)).toEqual([a.profileId, b.profileId]);
      const card = res.body.recommendations[1].worker;
      expect(card).toMatchObject({ displayName: "Karim Mia", startingPriceBdt: 500, verification: "VERIFIED", rating: null, reviewCount: 0 });
      expect(res.body.recommendations[0]).toMatchObject({ rank: 1, matchedOn: ["CATEGORY"] });
    });

    it("drops unknown, draft, pending, unpublished, suspended and filter-violating ids", async () => {
      const admin = await t.newAdmin();
      const good = await t.createWorker({ admin });
      const draft = await t.createWorker({ stage: "draft" });
      const pending = await t.createWorker({ stage: "submitted" });
      const unpublished = await t.createWorker({ stage: "approved", admin });
      const suspended = await t.createWorker({ admin });
      await admin.agent.post(`${t.api}/admin/workers/${suspended.profileId}/suspension`).send({ suspended: true, reason: "test" });
      const wrongCategory = await t.createWorker({ admin, services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 400 }] });
      const user = await t.signUpAndLogin("cust2@example.com");
      const ids = [good, draft, pending, unpublished, suspended, wrongCategory].map((w) => w.profileId);
      fake.reply = () => response([...ids.map((id, i) => ref(id, i + 1)), ref("00000000-0000-7000-8000-000000000000", 7), ref("not-a-real-worker-id-at-all-000000000", 8)].slice(0, 6).concat([ref("00000000-0000-7000-8000-000000000000", 7)]));
      const res = await post(user.agent, { message: "electrician" });
      expect(res.status).toBe(200);
      expect(res.body.recommendations.map((r: any) => r.worker.id)).toEqual([good.profileId]);
      // the AI claimed a result list; the database disagreed, so the text must not keep claiming it
      expect(res.body.message).toContain("changed");
    });

    it("applies the stated filters in the database (budget / area / experience)", async () => {
      const admin = await t.newAdmin();
      const cheap = await t.createWorker({ admin, serviceAreas: ["Sylhet"], experienceYears: 8, services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 600 }] });
      const dear = await t.createWorker({ admin, serviceAreas: ["Sylhet"], experienceYears: 8, services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 5000 }] });
      const farAway = await t.createWorker({ admin, serviceAreas: ["Dhaka"], experienceYears: 8, services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 600 }] });
      const junior = await t.createWorker({ admin, serviceAreas: ["Sylhet"], experienceYears: 1, services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 600 }] });
      const user = await t.signUpAndLogin("cust3@example.com");
      fake.reply = () =>
        response([cheap, dear, farAway, junior].map((w, i) => ref(w.profileId, i + 1)), {
          intent: { category: "plumbing", location: "Sylhet", maxBudgetBdt: 1500, minExperienceYears: 5 },
        });
      const res = await post(user.agent, { message: "plumber in Sylhet under 1500, 5+ years" });
      expect(res.body.recommendations.map((r: any) => r.worker.id)).toEqual([cheap.profileId]);
    });

    it("never exposes private fields", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ admin });
      const user = await t.signUpAndLogin("cust4@example.com");
      fake.reply = () => response([ref(w.profileId)]);
      const res = await post(user.agent, { message: "electrician" });
      const text = JSON.stringify(res.body);
      for (const secret of [w.email, w.userId, "reviewNote", "suspensionReason", "userId", "onboardingStatus", "verificationStatus"]) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(res.body.recommendations[0].worker).sort()).toEqual(
        ["categories", "displayName", "experienceYears", "headline", "id", "primaryCategory", "publishedAt", "rating", "reviewCount", "serviceAreas", "slug", "startingPriceBdt", "verification"].sort(),
      );
    });

    it("rejects an AI response that carries facts, extra fields or an external link", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ admin });
      const user = await t.signUpAndLogin("cust5@example.com");
      const bad: unknown[] = [
        response([{ ...ref(w.profileId), displayName: "Invented Name", startingPriceBdt: 1 }]),
        { ...response([]), kind: "booked" },
        { ...response([]), bookingId: "b1" },
        { ...response([], { kind: "answer", answer: { text: "x", grounded: true, sources: [{ id: "a", title: "t", url: "https://evil.example" }] } }) },
        { ...response([]), intent: { category: "electrical", role: "admin" } },
        "just a string",
        null,
      ];
      for (const reply of bad) {
        fake.reply = () => reply;
        resetLimiter();
        const res = await post(user.agent, { message: "electrician" });
        expect(res.status, JSON.stringify(reply)).toBe(502);
        expect(res.body.code).toBe("AI_UNAVAILABLE");
        expect(JSON.stringify(res.body)).not.toMatch(/evil|Invented|stack|zod/i);
      }
    });

    it("passes knowledge answers through with site-relative source links only", async () => {
      const user = await t.signUpAndLogin("cust6@example.com");
      fake.reply = () =>
        response([], {
          kind: "answer",
          message: "You can cancel.",
          answer: { text: "You can cancel.", grounded: true, sources: [{ id: "cancellation#cancelling", title: "Cancelling", url: "/bookings" }] },
        });
      const res = await post(user.agent, { message: "can I cancel" });
      expect(res.body.answer.sources[0].url).toBe("/bookings");
    });
  });

  describe("failure handling and limits", () => {
    it("maps AI service failures to stable codes without leaking details", async () => {
      const user = await t.signUpAndLogin("fail@example.com");
      const cases: [AiClientError, number, string][] = [
        [new AiClientError("timeout"), 504, "AI_TIMEOUT"],
        [new AiClientError("unreachable"), 502, "AI_UNAVAILABLE"],
        [new AiClientError("bad_status", 500), 502, "AI_UNAVAILABLE"],
        [new AiClientError("bad_body", 200), 502, "AI_UNAVAILABLE"],
        [new AiClientError("rate_limited", 429), 429, "AI_RATE_LIMITED"],
      ];
      for (const [error, status, code] of cases) {
        fake.reply = () => {
          throw error;
        };
        resetLimiter();
        const res = await post(user.agent, { message: "electrician" });
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(JSON.stringify(res.body)).not.toMatch(/ai\.test|Bearer|token|stack/i);
      }
      // the core marketplace is unaffected
      expect((await t.client().get(`${t.api}/workers`)).status).toBe(200);
    });

    it("limits each user separately", async () => {
      const a = await t.signUpAndLogin("rl-a@example.com");
      const b = await t.signUpAndLogin("rl-b@example.com");
      fake.reply = () => response([]);
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await post(a.agent, { message: "electrician" })).status);
      expect(codes).toEqual([200, 200, 200, 429]);
      const limited = await post(a.agent, { message: "electrician" });
      expect(limited.body).toMatchObject({ code: "AI_RATE_LIMITED" });
      expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
      expect((await post(b.agent, { message: "electrician" })).status).toBe(200);
    });

    it("does not mix users: each call carries only that user's own hashed subject", async () => {
      const a = await t.signUpAndLogin("mix-a@example.com");
      const b = await t.signUpAndLogin("mix-b@example.com");
      fake.reply = () => response([]);
      await post(a.agent, { message: "one" });
      await post(b.agent, { message: "two" });
      expect(fake.calls[0]!.ctx.subject).not.toBe(fake.calls[1]!.ctx.subject);
      expect(fake.calls.map((c) => c.body.message)).toEqual(["one", "two"]);
    });
  });

  describe("internal tool endpoints (AI service only)", () => {
    const bearer = { Authorization: `Bearer ${AI.APP_API_SERVICE_TOKEN}` };

    it("require the service token: no token, wrong token, wrong scheme, or only a user session all fail", async () => {
      const user = await t.signUpAndLogin("internal@example.com");
      for (const path of ["/internal/ai/workers", "/internal/ai/categories"]) {
        expect((await t.client().get(`${t.api}${path}`)).status).toBe(401);
        expect((await t.client().get(`${t.api}${path}`).set("Authorization", "Bearer nope")).status).toBe(401);
        expect((await t.client().get(`${t.api}${path}`).set("Authorization", AI.APP_API_SERVICE_TOKEN)).status).toBe(401);
        expect((await t.client().get(`${t.api}${path}`).set("Authorization", `Bearer ${AI.AI_SERVICE_TOKEN}`)).status).toBe(401); // the other direction's secret
        expect((await user.agent.get(`${t.api}${path}`)).status).toBe(401);
        expect((await t.client().get(`${t.api}${path}`).set(bearer)).status).toBe(200);
      }
    });

    it("are read-only (no write verbs exist)", async () => {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const res = await t.client()[method](`${t.api}/internal/ai/workers`).set(bearer).send({});
        expect(res.status).toBe(404);
      }
    });

    it("search only ever returns publicly eligible workers and public fields", async () => {
      const admin = await t.newAdmin();
      const good = await t.createWorker({ admin });
      await t.createWorker({ stage: "draft" });
      await t.createWorker({ stage: "submitted" });
      await t.createWorker({ stage: "approved", admin });
      const suspended = await t.createWorker({ admin });
      await admin.agent.post(`${t.api}/admin/workers/${suspended.profileId}/suspension`).send({ suspended: true, reason: "test" });
      const res = await t.client().get(`${t.api}/internal/ai/workers?category=electrical&sort=experience&pageSize=5`).set(bearer);
      expect(res.status).toBe(200);
      expect(res.body.workers.map((w: any) => w.id)).toEqual([good.profileId]);
      expect(res.body.total).toBe(1);
      expect(JSON.stringify(res.body)).not.toMatch(/email|userId|reviewNote|suspension/);
    });

    it("validate arguments like the public search: injection attempts are 400, caps hold", async () => {
      for (const query of ["category=x'%3B%20DROP%20TABLE%20worker_profile", "location=Atlantis", "maxPrice=-1", "sort=id;select", "pageSize=0"]) {
        expect((await t.client().get(`${t.api}/internal/ai/workers?${query}`).set(bearer)).status).toBe(400);
      }
      const res = await t.client().get(`${t.api}/internal/ai/workers?pageSize=48&page=9`).set(bearer);
      expect(res.body.pageSize).toBe(24);
      expect(res.body.page).toBe(1);
    });

    it("lists only active categories", async () => {
      await t.prisma.serviceCategory.update({ where: { slug: "painting" }, data: { isActive: false } });
      try {
        const res = await t.client().get(`${t.api}/internal/ai/categories`).set(bearer);
        const slugs = res.body.categories.map((c: any) => c.slug);
        expect(slugs).toContain("plumbing");
        expect(slugs).not.toContain("painting");
        expect(Object.keys(res.body.categories[0]).sort()).toEqual(["description", "name", "slug"]);
      } finally {
        await t.prisma.serviceCategory.update({ where: { slug: "painting" }, data: { isActive: true } });
      }
    });
  });
});

describe("AI assistant when not configured", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("answers 503 AI_NOT_CONFIGURED, hides the internal routes, and leaves normal search alone", async () => {
    const user = await t.signUpAndLogin("noai@example.com");
    const chat = await user.agent.post(`${t.api}/ai/chat`).send({ message: "electrician" });
    expect(chat.status).toBe(503);
    expect(chat.body.code).toBe("AI_NOT_CONFIGURED");
    expect((await t.client().get(`${t.api}/ai/status`)).body).toEqual({ available: false });
    expect((await t.client().get(`${t.api}/internal/ai/workers`).set("Authorization", "Bearer anything")).status).toBe(404);
    expect((await t.client().get(`${t.api}/workers`)).status).toBe(200);
  });
});
