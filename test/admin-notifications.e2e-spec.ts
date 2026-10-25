import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { customer } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("announcements and notifications", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const draft = { title: "Scheduled maintenance", body: "The site will be read-only on Friday night.", audience: "ALL", severity: "WARNING" };

  describe("announcements", () => {
    it("drafts are invisible, published ones appear for the right audience, and archiving hides them again", async () => {
      const admin = await t.newAdmin();
      const cust = await customer(t, "Carol");
      const worker = await t.createWorker({ stage: "draft" });
      const create = (b: object) => admin.agent.post(`${t.api}/admin/announcements`).send(b);
      const all = (await create(draft)).body.announcement;
      const workersOnly = (await create({ ...draft, title: "Workers: payout news", audience: "WORKERS", severity: "INFO" })).body.announcement;
      expect(all).toMatchObject({ status: "DRAFT", live: false });
      expect((await t.client().get(`${t.api}/announcements`)).body.announcements).toEqual([]);

      expect((await admin.agent.post(`${t.api}/admin/announcements/${all.id}/publish`).send({})).status).toBe(400); // needs confirm
      const pub = await admin.agent.post(`${t.api}/admin/announcements/${all.id}/publish`).send({ confirm: true });
      expect(pub.body.announcement).toMatchObject({ status: "PUBLISHED", live: true });
      await admin.agent.post(`${t.api}/admin/announcements/${workersOnly.id}/publish`).send({ confirm: true });

      expect((await t.client().get(`${t.api}/announcements`)).body.announcements.map((a: { title: string }) => a.title)).toEqual(["Scheduled maintenance"]);
      const forCustomer = (await cust.agent.get(`${t.api}/me/announcements`)).body.announcements.map((a: { title: string }) => a.title);
      expect(forCustomer).toEqual(["Scheduled maintenance"]);
      const forWorker = (await worker.agent.get(`${t.api}/me/announcements`)).body.announcements.map((a: { title: string }) => a.title).sort();
      expect(forWorker).toEqual(["Scheduled maintenance", "Workers: payout news"]);
      expect((await t.client().get(`${t.api}/me/announcements`)).status).toBe(401);
      expect(JSON.stringify((await t.client().get(`${t.api}/announcements`)).body)).not.toMatch(/createdBy|audience|status/);

      expect((await admin.agent.post(`${t.api}/admin/announcements/${all.id}/publish`).send({ confirm: true })).body.code).toBe("NOT_DRAFT");
      await admin.agent.post(`${t.api}/admin/announcements/${all.id}/archive`).send({});
      expect((await t.client().get(`${t.api}/announcements`)).body.announcements).toEqual([]);
      expect((await admin.agent.patch(`${t.api}/admin/announcements/${all.id}`).send({ title: "Edited after archive" })).body.code).toBe("ARCHIVED");
      const trail = (await t.prisma.auditLog.findMany({ where: { targetId: all.id }, orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(trail).toEqual(["announcement.create", "announcement.publish", "announcement.archive"]);
    });

    it("honours the start/end window", async () => {
      const admin = await t.newAdmin();
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const later = new Date(Date.now() + 7_200_000).toISOString();
      const scheduled = (await admin.agent.post(`${t.api}/admin/announcements`).send({ ...draft, startsAt: soon, endsAt: later })).body.announcement;
      const published = await admin.agent.post(`${t.api}/admin/announcements/${scheduled.id}/publish`).send({ confirm: true });
      expect(published.body.announcement).toMatchObject({ status: "PUBLISHED", live: false }); // scheduled, not yet showing
      expect((await t.client().get(`${t.api}/announcements`)).body.announcements).toEqual([]);
      await t.prisma.announcement.update({ where: { id: scheduled.id }, data: { startsAt: new Date(Date.now() - 1000) } });
      expect((await t.client().get(`${t.api}/announcements`)).body.announcements).toHaveLength(1);
      await t.prisma.announcement.update({ where: { id: scheduled.id }, data: { endsAt: new Date(Date.now() - 500) } });
      expect((await t.client().get(`${t.api}/announcements`)).body.announcements).toEqual([]); // expired
    });

    it("validates input: lengths, severity, windows, unknown fields, expired publish", async () => {
      const admin = await t.newAdmin();
      const create = (b: object) => admin.agent.post(`${t.api}/admin/announcements`).send({ ...draft, ...b });
      for (const bad of [{ title: "x" }, { body: "" }, { severity: "LOUD" }, { audience: "EVERYONE" }, { startsAt: "tomorrow" }, { extra: 1 }, { title: "Bad\u0007title" }]) {
        expect((await create(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      const a = new Date(Date.now() + 100_000).toISOString();
      const b = new Date(Date.now() + 50_000).toISOString();
      expect((await create({ startsAt: a, endsAt: b })).body.code).toBe("BAD_WINDOW");
      const old = (await create({ endsAt: new Date(Date.now() - 1000).toISOString() })).body.announcement;
      expect((await admin.agent.post(`${t.api}/admin/announcements/${old.id}/publish`).send({ confirm: true })).body.code).toBe("ALREADY_EXPIRED");
    });

    it("needs notifications.manage", async () => {
      const other = await t.newAdminWith(["users.read"]);
      expect((await other.agent.get(`${t.api}/admin/announcements`)).status).toBe(403);
      expect((await other.agent.post(`${t.api}/admin/announcements`).send(draft)).status).toBe(403);
      const plain = await customer(t);
      expect((await plain.agent.post(`${t.api}/admin/announcements`).send(draft)).status).toBe(403);
      expect(await t.prisma.announcement.count()).toBe(0);
    });
  });

  describe("personal notifications", () => {
    it("staff can notify one user; the user reads, marks read, and nobody else can touch it", async () => {
      const admin = await t.newAdmin();
      const u = await customer(t, "Dina");
      const other = await customer(t, "Eve");
      const sent = await admin.agent.post(`${t.api}/admin/notifications`).send({ userId: u.userId, title: "About your report", body: "We looked into it and took action.", link: "/account/support" });
      expect(sent.status).toBe(201);
      const list = await u.agent.get(`${t.api}/notifications`);
      expect(list.body).toMatchObject({ unreadCount: 1, total: 1 });
      const n = list.body.notifications[0];
      expect(n).toMatchObject({ type: "admin.message", title: "About your report", link: "/account/support", readAt: null });
      expect((await u.agent.get(`${t.api}/notifications/unread-count`)).body).toEqual({ unreadCount: 1 });
      expect((await other.agent.get(`${t.api}/notifications`)).body.total).toBe(0);
      expect((await other.agent.post(`${t.api}/notifications/${n.id}/read`).send({})).status).toBe(404);
      expect((await u.agent.get(`${t.api}/notifications`)).body.unreadCount).toBe(1);
      expect((await u.agent.post(`${t.api}/notifications/${n.id}/read`).send({})).body).toEqual({ unreadCount: 0 });
      expect((await u.agent.post(`${t.api}/notifications/${n.id}/read`).send({})).status).toBe(200); // idempotent
      expect((await u.agent.get(`${t.api}/notifications?unread=true`)).body.total).toBe(0);
      await admin.agent.post(`${t.api}/admin/notifications`).send({ userId: u.userId, title: "Second message", body: "Another note." });
      expect((await u.agent.post(`${t.api}/notifications/read-all`).send({})).body).toEqual({ unreadCount: 0 });
      expect((await t.client().get(`${t.api}/notifications`)).status).toBe(401);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "notification.send" }, orderBy: { seq: "asc" } });
      expect(audit).toMatchObject({ actorId: admin.userId, targetType: "User", targetId: u.userId });
      expect(JSON.stringify(audit.metadata)).not.toContain("took action"); // body text is not copied to the log
    });

    it("only allows in-app links and valid recipients", async () => {
      const admin = await t.newAdmin();
      const u = await customer(t);
      const send = (b: object) => admin.agent.post(`${t.api}/admin/notifications`).send({ userId: u.userId, title: "Hello there", body: "Some text.", ...b });
      for (const link of ["https://evil.example/phish", "//evil.example", "javascript:alert(1)", "account", "/a b"]) {
        expect((await send({ link })).status, link).toBe(400);
      }
      expect((await send({ userId: "a".repeat(32) })).status).toBe(404);
      expect((await send({ userId: "x" })).status).toBe(400);
      expect((await send({ title: "" })).status).toBe(400);
      expect((await send({ extra: true })).status).toBe(400);
      expect(await t.prisma.notification.count()).toBe(0);
      // the database enforces it too
      await expect(t.prisma.notification.create({ data: { userId: u.userId, type: "x", title: "t", body: "b", link: "https://evil.example" } })).rejects.toThrow();
    });
  });
});
