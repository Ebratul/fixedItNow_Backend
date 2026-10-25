import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, uniqueEmail, validWorkerProfile, type TestApp } from "./helpers.js";

describe("authorization", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const PROTECTED: [string, string][] = [
    ["get", "/me"],
    ["put", "/me/customer-profile"],
    ["put", "/me/worker-profile"],
    ["post", "/me/worker-profile/submit"],
    ["get", "/worker/workspace"],
    ["get", "/admin/workers"],
    ["post", "/admin/workers/0192a000-0000-7000-8000-000000000000/verification"],
  ];

  describe("unauthenticated visitors", () => {
    it.each(PROTECTED)("get 401 on %s %s", async (method, path) => {
      const res = await (t.client() as any)[method](`${t.api}${path}`).send({});
      expect(res.status).toBe(401);
    });

    it("can still use public routes", async () => {
      for (const path of ["/health", "/config/auth", "/categories"]) {
        expect((await t.client().get(`${t.api}${path}`)).status).toBe(200);
      }
    });

    it("an unknown route is a 404, not an authentication error", async () => {
      expect((await t.client().get(`${t.api}/nope`)).status).toBe(404);
    });
  });

  describe("customers", () => {
    it("only ever see their own data", async () => {
      const a = await t.signUpAndLogin(uniqueEmail("a"));
      const b = await t.signUpAndLogin(uniqueEmail("b"));
      await a.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Alice A", preferredDivision: "Dhaka" });
      await b.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Bob B" });

      const meA = (await a.agent.get(`${t.api}/me`)).body;
      const meB = (await b.agent.get(`${t.api}/me`)).body;
      expect(meA.user.id).toBe(a.userId);
      expect(meA.customer.profile.displayName).toBe("Alice A");
      expect(JSON.stringify(meA)).not.toContain("Bob B");
      expect(JSON.stringify(meA)).not.toContain(b.email);
      expect(meB.customer.profile.displayName).toBe("Bob B");
    });

    it("cannot target another user by smuggling an id into the body or query", async () => {
      const a = await t.signUpAndLogin(uniqueEmail("a"));
      const b = await t.signUpAndLogin(uniqueEmail("b"));
      await b.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Bob B" });

      const res = await a.agent.put(`${t.api}/me/customer-profile?userId=${b.userId}`).send({ displayName: "Hacked", userId: b.userId });
      expect(res.status).toBe(400); // strict schema rejects the unknown key
      const bob = await t.prisma.customerProfile.findUniqueOrThrow({ where: { userId: b.userId } });
      expect(bob.displayName).toBe("Bob B");

      // A query-string userId is ignored: the write lands on the caller.
      const ok = await a.agent.put(`${t.api}/me/customer-profile?userId=${b.userId}`).send({ displayName: "Alice A" });
      expect(ok.status).toBe(200);
      expect((await t.prisma.customerProfile.findUniqueOrThrow({ where: { userId: b.userId } })).displayName).toBe("Bob B");
      expect((await t.prisma.customerProfile.findUniqueOrThrow({ where: { userId: a.userId } })).displayName).toBe("Alice A");
    });
  });

  describe("privilege escalation", () => {
    it("a user cannot make themselves admin through any API", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      const attempts = [
        u.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Me", role: "ADMIN" }),
        u.agent.put(`${t.api}/me/worker-profile`).send({ role: "ADMIN" }),
        u.agent.post(`${t.api}/auth/update-user`).send({ role: "ADMIN", isAdmin: true, name: "Me" }),
        u.agent.put(`${t.api}/me?role=ADMIN`).send({ role: "ADMIN" }),
      ];
      await Promise.all(attempts);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
      expect(user.role).toBe("USER");
      expect((await u.agent.get(`${t.api}/admin/workers`)).status).toBe(403);
      expect((await u.agent.get(`${t.api}/me`)).body.isAdmin).toBe(false);
    });

    it("non-admins get 403 on every admin endpoint", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      expect((await u.agent.get(`${t.api}/admin/workers`)).status).toBe(403);
      const res = await u.agent
        .post(`${t.api}/admin/workers/0192a000-0000-7000-8000-000000000000/verification`)
        .send({ decision: "VERIFIED" });
      expect(res.status).toBe(403);
    });

    it("admin status is re-read from the database on every request", async () => {
      await t.newAdmin(); // another super administrator, so this one is not the last (the database protects the last)
      const u = await t.signUpAndLogin(uniqueEmail());
      await t.makeAdmin(u.userId);
      expect((await u.agent.get(`${t.api}/admin/workers`)).status).toBe(200);
      await t.prisma.user.update({ where: { id: u.userId }, data: { role: "USER", adminRoleId: null } }); // the CHECK constraint forbids a role on a non-admin
      expect((await u.agent.get(`${t.api}/admin/workers`)).status).toBe(403); // same session, role revoked
    });
  });

  describe("worker ownership and approval", () => {
    it("a worker cannot edit another worker's profile", async () => {
      const a = await t.signUpAndLogin(uniqueEmail("wa"));
      const b = await t.signUpAndLogin(uniqueEmail("wb"));
      await a.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Worker A" });
      await b.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Worker B" });
      const profileB = await t.prisma.workerProfile.findUniqueOrThrow({ where: { userId: b.userId } });

      for (const body of [
        { id: profileB.id, displayName: "Hijacked" },
        { userId: b.userId, displayName: "Hijacked" },
      ]) {
        expect((await a.agent.put(`${t.api}/me/worker-profile`).send(body)).status).toBe(400);
      }
      expect((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: profileB.id } })).displayName).toBe("Worker B");

      await a.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Worker A v2" });
      expect((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: profileB.id } })).displayName).toBe("Worker B");
    });

    it("a worker can never set their own verification status", async () => {
      const w = await t.signUpAndLogin(uniqueEmail("w"));
      for (const field of ["verificationStatus", "onboardingStatus", "reviewedById", "reviewNote"]) {
        const res = await w.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Worker", [field]: "VERIFIED" });
        expect(res.status).toBe(400);
      }
      await w.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      const submit = await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect(submit.status).toBe(200);
      // Submitting asks for review; it does not grant approval.
      expect(submit.body.profile.verificationStatus).toBe("PENDING");
      expect(submit.body.profile.onboardingStatus).toBe("SUBMITTED");
      const self = await w.agent
        .post(`${t.api}/admin/workers/${(await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: w.userId } })).id}/verification`)
        .send({ decision: "VERIFIED" });
      expect(self.status).toBe(403);
    });

    it("approved-worker routes need submission AND reviewer verification", async () => {
      const w = await t.signUpAndLogin(uniqueEmail("w"));
      const admin = await t.signUpAndLogin(uniqueEmail("admin"));
      await t.makeAdmin(admin.userId);

      expect((await w.agent.get(`${t.api}/worker/workspace`)).status).toBe(403); // no profile
      await w.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      expect((await w.agent.get(`${t.api}/worker/workspace`)).status).toBe(403); // draft
      await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect((await w.agent.get(`${t.api}/worker/workspace`)).status).toBe(403); // pending

      const profile = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: w.userId } });
      const review = await admin.agent.post(`${t.api}/admin/workers/${profile.id}/verification`).send({ decision: "VERIFIED" });
      expect(review.status).toBe(200);
      expect((await w.agent.get(`${t.api}/worker/workspace`)).status).toBe(200); // approved
    });
  });

  describe("administrative review", () => {
    async function pendingWorker() {
      const w = await t.signUpAndLogin(uniqueEmail("w"));
      await w.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      const profile = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: w.userId } });
      return { ...w, profileId: profile.id };
    }
    async function admin() {
      const a = await t.signUpAndLogin(uniqueEmail("admin"));
      await t.makeAdmin(a.userId);
      return a;
    }

    it("lets an admin list pending workers and record a decision with an audit trail", async () => {
      const w = await pendingWorker();
      const a = await admin();

      const list = await a.agent.get(`${t.api}/admin/workers?status=PENDING`);
      expect(list.status).toBe(200);
      expect(list.body.workers.map((x: any) => x.id)).toContain(w.profileId);

      const res = await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" });
      expect(res.status).toBe(200);
      expect(res.body.worker.verificationStatus).toBe("VERIFIED");

      const row = await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } });
      expect(row.reviewedById).toBe(a.userId);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { targetId: w.profileId } });
      expect(audit.actorId).toBe(a.userId);
      expect(audit.action).toBe("worker.verification.review");
    });

    it("two admins deciding at the same moment: exactly one decision is recorded, the other gets 409", async () => {
      const w = await pendingWorker();
      const [a, b] = [await admin(), await admin()];
      const [r1, r2] = await Promise.all([
        a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" }),
        b.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "REJECTED", note: "Incomplete profile details." }),
      ]);
      expect([r1.status, r2.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const winner = r1.status === 200 ? a : b;
      const row = await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } });
      expect(row.reviewedById).toBe(winner.userId);
      expect(await t.prisma.auditLog.count({ where: { targetId: w.profileId, action: "worker.verification.review" } })).toBe(1);
    });

    it("requires a reason when not approving, and validates the id", async () => {
      const w = await pendingWorker();
      const a = await admin();
      expect((await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "REJECTED" })).status).toBe(400);
      expect((await a.agent.post(`${t.api}/admin/workers/not-a-uuid/verification`).send({ decision: "VERIFIED" })).status).toBe(400);
      expect((await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "PENDING" })).status).toBe(400);
      const ok = await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "RESUBMISSION_REQUIRED", note: "Add a clearer description." });
      expect(ok.status).toBe(200);
    });

    it("only reviews profiles that are pending, and 404s for unknown ids", async () => {
      const w = await pendingWorker();
      const a = await admin();
      await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" });
      expect((await a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "REJECTED", note: "x" })).status).toBe(409);
      expect((await a.agent.post(`${t.api}/admin/workers/0192a000-0000-7000-8000-000000000000/verification`).send({ decision: "VERIFIED" })).status).toBe(404);
    });

    it("an admin cannot review their own worker profile", async () => {
      const a = await admin();
      await a.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      await a.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      const own = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: a.userId } });
      const res = await a.agent.post(`${t.api}/admin/workers/${own.id}/verification`).send({ decision: "VERIFIED" });
      expect(res.status).toBe(403);
      expect((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: own.id } })).verificationStatus).toBe("PENDING");
    });
  });

  describe("CSRF defence on state-changing API calls", () => {
    it("rejects writes without the web app's Origin even with a valid cookie", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      const login = await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: u.email, password: "correct-horse-battery" });
      const cookie = [login.headers["set-cookie"]].flat().map((c) => c!.split(";")[0]).join("; ");
      const request = (await import("supertest")).default;
      const noOrigin = await request(t.app.getHttpServer()).put(`${t.api}/me/customer-profile`).set("Cookie", cookie).send({ displayName: "Eve" });
      const evil = await request(t.app.getHttpServer()).put(`${t.api}/me/customer-profile`).set("Cookie", cookie).set("Origin", "https://evil.example").send({ displayName: "Eve" });
      expect(noOrigin.status).toBe(403);
      expect(evil.status).toBe(403);
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });
  });

  describe("error hygiene", () => {
    it("does not leak internals on bad input", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      const res = await u.agent.put(`${t.api}/me/worker-profile`).send({ services: [{ categorySlug: "x'; DROP TABLE user;--", pricingModel: "FIXED" }] });
      expect(res.status).toBe(400);
      expect(res.text).not.toMatch(/prisma|postgres|stack|node_modules/i);
    });
  });
});

describe("API rate limiting", () => {
  it("throttles an abusive client on application endpoints", async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: "true" });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 130; i++) statuses.push((await limited.client().get(`${limited.api}/categories`)).status);
      expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });
});
