import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, uniqueEmail, type TestApp, createTestApp } from "./helpers.js";

describe("admin user management", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const suspend = (admin: { agent: { post: (u: string) => { send: (b: object) => Promise<{ status: number; body: Record<string, unknown> }> } } }, id: string, body: object = { suspended: true, reason: "Repeated abuse", confirm: true }) =>
    admin.agent.post(`${t.api}/admin/users/${id}/suspension`).send(body);

  describe("listing", () => {
    it("searches, filters and paginates, and never returns credentials", async () => {
      const admin = await t.newAdmin();
      const people = [];
      for (let i = 0; i < 5; i++) people.push(await t.signUpAndLogin(`person${i}@example.com`, `Person Number${i}`));
      await t.createWorker({ stage: "submitted", admin });
      const all = await admin.agent.get(`${t.api}/admin/users?pageSize=3&page=2`);
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ page: 2, pageSize: 3 });
      expect(all.body.users).toHaveLength(3);
      expect(all.body.total).toBe(7);
      expect(all.body.totalPages).toBe(3);
      const byName = await admin.agent.get(`${t.api}/admin/users?q=number3`);
      expect(byName.body.users.map((u: { email: string }) => u.email)).toEqual(["person3@example.com"]);
      const byEmail = await admin.agent.get(`${t.api}/admin/users?q=PERSON4@EXAMPLE`);
      expect(byEmail.body.total).toBe(1);
      expect((await admin.agent.get(`${t.api}/admin/users?role=ADMIN`)).body.total).toBe(1);
      expect((await admin.agent.get(`${t.api}/admin/users?kind=worker`)).body.total).toBe(1);
      const json = JSON.stringify(all.body) + JSON.stringify(byName.body);
      expect(json).not.toMatch(/password|scrypt|token|\$argon/i);
    });

    it("validates the query string", async () => {
      const admin = await t.newAdmin();
      for (const q of ["pageSize=500", "page=0", "role=OWNER", "status=banned", "q="]) {
        expect((await admin.agent.get(`${t.api}/admin/users?${q}`)).status, q).toBe(400);
      }
      expect((await admin.agent.get(`${t.api}/admin/users/not*valid`)).status).toBe(400);
      expect((await admin.agent.get(`${t.api}/admin/users/${"a".repeat(32)}`)).status).toBe(404);
    });

    it("shows a user's detail with counts and recent admin actions", async () => {
      const admin = await t.newAdmin();
      const u = await t.signUpAndLogin("detail@example.com", "Detail Person");
      await suspend(admin, u.userId);
      const res = await admin.agent.get(`${t.api}/admin/users/${u.userId}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: "detail@example.com", suspended: true, suspensionReason: "Repeated abuse", role: "USER" });
      expect(res.body.user.recentActions[0]).toMatchObject({ action: "user.suspend", by: expect.any(String), reason: "Repeated abuse" });
      expect(JSON.stringify(res.body)).not.toMatch(/password|scrypt/i);
    });
  });

  describe("suspension", () => {
    it("revokes sessions, blocks the API and sign-in, and can be reversed", async () => {
      const admin = await t.newAdmin();
      const u = await t.signUpAndLogin("victim@example.com");
      expect((await u.agent.get(`${t.api}/me`)).status).toBe(200);

      const res = await suspend(admin, u.userId);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: u.userId, suspended: true });
      expect(await t.prisma.session.count({ where: { userId: u.userId } })).toBe(0);
      expect((await u.agent.get(`${t.api}/me`)).status).toBe(401); // session is gone

      const login = await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: "victim@example.com", password: PASSWORD });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe("ACCOUNT_SUSPENDED");
      // a wrong password gets the usual answer, not the suspension notice (no account probing)
      const wrong = await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: "victim@example.com", password: "definitely-wrong-password" });
      expect(wrong.body.code).not.toBe("ACCOUNT_SUSPENDED");

      const back = await suspend(admin, u.userId, { suspended: false, reason: "Appeal accepted", confirm: true });
      expect(back.status).toBe(200);
      expect((await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: "victim@example.com", password: PASSWORD })).status).toBe(200);

      const trail = await t.prisma.auditLog.findMany({ where: { targetType: "User", targetId: u.userId }, orderBy: { seq: "asc" } });
      expect(trail.map((r) => r.action)).toEqual(["user.suspend", "user.restore"]);
      expect(trail[0]).toMatchObject({ actorId: admin.userId });
      expect(trail[0]!.metadata).toMatchObject({ reason: "Repeated abuse", signedOutDevices: 1 });
    });

    it("a session that exists at the moment of suspension is refused by the auth guard too", async () => {
      const admin = await t.newAdmin();
      const u = await t.signUpAndLogin("racing@example.com");
      // simulate a session created in the instant between the two statements
      await t.prisma.user.update({ where: { id: u.userId }, data: { suspendedAt: new Date(), suspensionReason: "x" } });
      const res = await u.agent.get(`${t.api}/me`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
      expect(admin.userId).toBeDefined();
    });

    it("requires a reason and explicit confirmation, rejects unknown fields and repeats", async () => {
      const admin = await t.newAdmin();
      const u = await t.signUpAndLogin("strict@example.com");
      expect((await suspend(admin, u.userId, { suspended: true, reason: "abuse" })).status).toBe(400);
      expect((await suspend(admin, u.userId, { suspended: true, confirm: true })).status).toBe(400);
      expect((await suspend(admin, u.userId, { suspended: true, reason: "ab", confirm: true })).status).toBe(400);
      expect((await suspend(admin, u.userId, { suspended: true, reason: "abuse", confirm: true, role: "ADMIN" })).status).toBe(400);
      expect((await suspend(admin, u.userId, { suspended: true, reason: "abuse\u0007", confirm: true })).status).toBe(400);
      expect((await suspend(admin, u.userId)).status).toBe(200);
      expect((await suspend(admin, u.userId)).status).toBe(409);
      expect((await suspend(admin, "a".repeat(32))).status).toBe(404);
    });

    it("cannot suspend yourself or an administrator more powerful than you", async () => {
      const ops = await t.newAdminWith(["users.read", "users.suspend"]);
      const boss = await t.newAdmin();
      const self = await suspend(ops, ops.userId);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe("SELF_ACTION");
      const up = await suspend(ops, boss.userId);
      expect(up.status).toBe(403);
      expect(up.body.code).toBe("TARGET_TOO_POWERFUL");
      // peers with the same permissions are fine
      const peer = await t.newAdminWith(["users.read", "users.suspend"]);
      expect((await suspend(ops, peer.userId)).status).toBe(200);
    });

    it("needs users.suspend (users.read is not enough)", async () => {
      const reader = await t.newAdminWith(["users.read"]);
      const u = await t.signUpAndLogin("safe@example.com");
      expect((await suspend(reader, u.userId)).status).toBe(403);
    });

    it("hides a suspended worker's public profile and restores it afterwards", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ stage: "published", admin });
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).status).toBe(200);
      await suspend(admin, w.userId);
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).status).toBe(404);
      const search = await t.client().get(`${t.api}/workers`);
      expect(JSON.stringify(search.body)).not.toContain(w.slug);
      await suspend(admin, w.userId, { suspended: false, reason: "Cleared", confirm: true });
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).status).toBe(200);
    });
  });

  describe("registration switch", () => {
    it("refuses new sign-ups while registrations are closed, but existing users still sign in", async () => {
      const admin = await t.newAdmin();
      const existing = await t.signUpAndLogin("existing@example.com");
      const off = await admin.agent.put(`${t.api}/admin/settings/platform.registrationsOpen`).send({ value: false, reason: "Invite only for now" });
      expect(off.status).toBe(200);
      const attempt = await t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "New Person", email: uniqueEmail("late"), password: PASSWORD });
      expect(attempt.status).toBe(403);
      expect(attempt.body.code).toBe("REGISTRATIONS_CLOSED");
      expect((await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: "existing@example.com", password: PASSWORD })).status).toBe(200);
      await admin.agent.put(`${t.api}/admin/settings/platform.registrationsOpen`).send({ value: true, reason: "Reopened" });
      const ok = await t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "New Person", email: uniqueEmail("open"), password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(existing.userId).toBeDefined();
    });
  });
});
