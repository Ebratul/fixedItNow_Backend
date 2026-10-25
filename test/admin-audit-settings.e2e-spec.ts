import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../src/admin/audit/audit.service.js";
import { csvCell } from "../src/admin/audit/audit-query.service.js";
import { sanitizeAuditMetadata } from "../src/admin/audit/audit-sanitize.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("audit trail and platform settings", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const record = (actorId: string | null, action: string, metadata: Record<string, unknown> = {}, targetId = "t1") =>
    t.app.get(AuditService).record(t.prisma, { actorId, action, targetType: "Test", targetId, metadata });

  describe("hash chain", () => {
    it("links every row to the previous one with a gap-free sequence", async () => {
      const admin = await t.newAdmin();
      for (let i = 0; i < 4; i++) await record(admin.userId, `test.step${i}`);
      const rows = await t.prisma.auditLog.findMany({ orderBy: { seq: "asc" } });
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(rows[0]!.prevHash).toBe("0".repeat(64));
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
      expect(new Set(rows.map((r) => r.hash)).size).toBe(4);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash) && r.actorSnapshot === admin.userId)).toBe(true);
    });

    it("stays consistent under concurrent writers", async () => {
      const admin = await t.newAdmin();
      await Promise.all(Array.from({ length: 25 }, (_, i) => record(admin.userId, `test.parallel${i}`)));
      const rows = await t.prisma.auditLog.findMany({ orderBy: { seq: "asc" } });
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      const verify = await admin.agent.get(`${t.api}/admin/audit/verify`);
      expect(verify.body).toMatchObject({ valid: true, checked: 25, firstInvalidSeq: null });
    });

    it("verify reports a valid chain, then pinpoints tampering made behind the application's back", async () => {
      const admin = await t.newAdmin();
      for (let i = 0; i < 5; i++) await record(admin.userId, `test.row${i}`, { n: i });
      const ok = await admin.agent.get(`${t.api}/admin/audit/verify`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ valid: true, checked: 5, headSeq: 5 });
      expect(ok.body.headHash).toMatch(/^[0-9a-f]{64}$/);

      // A privileged attacker disables the append-only trigger and edits row 3. The chain still notices.
      await t.prisma.$executeRawUnsafe(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      try {
        await t.prisma.$executeRawUnsafe(`UPDATE audit_log SET metadata = '{"n":"forged"}' WHERE seq = 3`);
      } finally {
        await t.prisma.$executeRawUnsafe(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
      }
      const bad = await admin.agent.get(`${t.api}/admin/audit/verify`);
      expect(bad.body).toMatchObject({ valid: false, firstInvalidSeq: 3, problems: { contentChanged: true } });

      // Deleting a row from the middle breaks the sequence and the link.
      await t.prisma.$executeRawUnsafe(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      try {
        await t.prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE seq = 2`);
      } finally {
        await t.prisma.$executeRawUnsafe(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
      }
      const gap = await admin.agent.get(`${t.api}/admin/audit/verify`);
      expect(gap.body.valid).toBe(false);
      expect(gap.body.problems.gapOrReorder).toBe(true);
    });

    it("the verification itself is logged, by whom, with its result", async () => {
      const admin = await t.newAdmin();
      await admin.agent.get(`${t.api}/admin/audit/verify`);
      const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "audit.verify" } });
      expect(entry).toMatchObject({ actorId: admin.userId });
      expect(entry.metadata).toMatchObject({ valid: true });
    });

    it("rows keep their hash and the actor snapshot when the actor's account is deleted", async () => {
      const admin = await t.newAdmin();
      const other = await t.newAdmin();
      await record(admin.userId, "test.before_delete");
      await t.prisma.user.delete({ where: { id: admin.userId } });
      const row = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "test.before_delete" } });
      expect(row).toMatchObject({ actorId: null, actorSnapshot: admin.userId });
      const verify = await other.agent.get(`${t.api}/admin/audit/verify`);
      expect(verify.body.valid).toBe(true);
      const list = await other.agent.get(`${t.api}/admin/audit?action=test.before_delete`);
      expect(list.body.entries[0].actor).toMatchObject({ id: admin.userId, removed: true });
    });
  });

  describe("recording safely", () => {
    it("redacts secrets and bounds metadata", () => {
      const out = sanitizeAuditMetadata({
        reason: "ok", password: "hunter2", newPassword: "x", otp: "123456", apiKey: "k", Authorization: "Bearer abc",
        nested: { sessionToken: "s", nidNumber: "1234567890", fine: 1 }, long: "x".repeat(1000), buf: Buffer.from("secret"),
        list: Array.from({ length: 100 }, (_, i) => i),
      }) as Record<string, unknown>;
      expect(out).toMatchObject({ reason: "ok", password: "[redacted]", newPassword: "[redacted]", otp: "[redacted]", apiKey: "[redacted]", Authorization: "[redacted]", buf: "[redacted]" });
      expect(out.nested).toEqual({ sessionToken: "[redacted]", nidNumber: "[redacted]", fine: 1 });
      expect((out.long as string).length).toBeLessThan(310);
      expect(out.list as unknown[]).toHaveLength(25);
      expect(JSON.stringify(out)).not.toMatch(/hunter2|123456|Bearer abc|1234567890/);
    });

    it("stores the request id so an entry can be traced to its access-log line", async () => {
      const admin = await t.newAdmin();
      const role = await admin.agent.post(`${t.api}/admin/roles`).send({ key: "traceable", name: "Traceable", description: "d", permissions: ["users.read"] }).set("X-Request-Id", "trace-request-0001");
      expect(role.headers["x-request-id"]).toBe("trace-request-0001");
      const row = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "role.create" } });
      expect((row.metadata as { requestId?: string }).requestId).toBe("trace-request-0001");
    });
  });

  describe("reading the log", () => {
    it("filters by actor, action, target and time, and paginates newest first", async () => {
      const a = await t.newAdmin();
      const b = await t.newAdmin();
      await record(a.userId, "test.alpha", {}, "x1");
      await record(b.userId, "test.beta", {}, "x2");
      await record(a.userId, "test.alpha", {}, "x3");
      const all = await a.agent.get(`${t.api}/admin/audit?action=test.*&pageSize=2`);
      expect(all.body.total).toBe(3);
      expect(all.body.entries.map((e: { targetId: string }) => e.targetId)).toEqual(["x3", "x2"]);
      expect(all.body.totalPages).toBe(2);
      expect((await a.agent.get(`${t.api}/admin/audit?actorId=${b.userId}&action=test.*`)).body.total).toBe(1);
      expect((await a.agent.get(`${t.api}/admin/audit?targetId=x3`)).body.entries[0].actor).toMatchObject({ id: a.userId });
      expect((await a.agent.get(`${t.api}/admin/audit?from=2999-01-01`)).body.total).toBe(0);
      expect((await a.agent.get(`${t.api}/admin/audit?q=ALPHA`)).body.total).toBe(2);
      expect((await a.agent.get(`${t.api}/admin/audit/actions`)).body.actions).toContain("test.beta");
    });

    it("validates filters", async () => {
      const a = await t.newAdmin();
      for (const q of ["pageSize=1000", "page=0", "from=yesterday", "action=DROP TABLE", "targetType=a;b"]) {
        expect((await a.agent.get(`${t.api}/admin/audit?${q}`)).status, q).toBe(400);
      }
    });

    it("exports CSV (audited, formula-safe) only for those allowed to read the log", async () => {
      const a = await t.newAdmin();
      await record(a.userId, "test.export", { note: "=HYPERLINK(\"http://evil\")" });
      const csv = await a.agent.get(`${t.api}/admin/audit/export?action=test.export`);
      expect(csv.status).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.headers["cache-control"]).toBe("no-store");
      expect(csv.text.split("\n")[0]).toBe("seq,time,actor,action,targetType,targetId,metadata,hash");
      expect(csv.text).toContain("test.export");
      expect(csvCell("=1+1")).toBe("'=1+1");
      expect(csvCell("@cmd")).toBe("'@cmd");
      expect(csvCell('a,"b"')).toBe('"a,""b"""');
      expect(await t.prisma.auditLog.count({ where: { action: "audit.export" } })).toBe(1);
      const noAccess = await t.newAdminWith(["users.read"]);
      expect((await noAccess.agent.get(`${t.api}/admin/audit/export`)).status).toBe(403);
      expect((await noAccess.agent.get(`${t.api}/admin/audit`)).status).toBe(403);
    });
  });

  describe("platform settings", () => {
    it("lists every setting with its value, default and effect, and exposes only public ones without a session", async () => {
      const admin = await t.newAdmin();
      const list = await admin.agent.get(`${t.api}/admin/settings`);
      expect(list.status).toBe(200);
      const keys = list.body.settings.map((s: { key: string }) => s.key);
      expect(keys).toEqual(expect.arrayContaining(["platform.maintenanceMode", "platform.registrationsOpen", "finance.commissionBps", "workers.requireIdentityDocuments", "ai.assistantEnabled"]));
      expect(list.body.settings.every((s: { effect: string; description: string }) => s.effect && s.description)).toBe(true);
      const pub = await t.client().get(`${t.api}/config/platform`);
      expect(pub.status).toBe(200);
      expect(pub.body).toEqual({ maintenanceMode: false, maintenanceMessage: "", registrationsOpen: true, assistantEnabled: true });
      expect(JSON.stringify(pub.body)).not.toMatch(/commission|identity/);
    });

    it("validates values, rejects unknown keys, records before/after with the reason, and refuses no-ops", async () => {
      const admin = await t.newAdmin();
      const put = (key: string, body: object) => admin.agent.put(`${t.api}/admin/settings/${key}`).send(body);
      expect((await put("nope.not.real", { value: true, reason: "test it" })).status).toBe(400);
      expect((await put("finance.commissionBps", { value: 99999, reason: "too high" })).status).toBe(400);
      expect((await put("finance.commissionBps", { value: 12.5, reason: "fraction" })).status).toBe(400);
      expect((await put("finance.commissionBps", { value: "ten", reason: "text" })).status).toBe(400);
      expect((await put("platform.maintenanceMode", { value: "yes", reason: "wrong type" })).status).toBe(400);
      expect((await put("platform.maintenanceMode", { value: true })).status).toBe(400);
      expect((await put("platform.maintenanceMode", { value: true, reason: "ok", extra: 1 })).status).toBe(400);
      const ok = await put("finance.commissionBps", { value: 1000, reason: "Pilot rate agreed with finance" });
      expect(ok.status).toBe(200);
      expect(ok.body.setting).toMatchObject({ key: "finance.commissionBps", value: 1000, isDefault: false });
      expect((await put("finance.commissionBps", { value: 1000, reason: "same again" })).status).toBe(409);
      const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "setting.update", targetId: "finance.commissionBps" } });
      expect(entry).toMatchObject({ actorId: admin.userId });
      expect(entry.metadata).toMatchObject({ from: 0, to: 1000, reason: "Pilot rate agreed with finance" });
    });

    it("separates reading from changing", async () => {
      const reader = await t.newAdminWith(["settings.read"]);
      expect((await reader.agent.get(`${t.api}/admin/settings`)).status).toBe(200);
      expect((await reader.agent.put(`${t.api}/admin/settings/platform.maintenanceMode`).send({ value: true, reason: "sneaky" })).status).toBe(403);
      const none = await t.newAdminWith(["users.read"]);
      expect((await none.agent.get(`${t.api}/admin/settings`)).status).toBe(403);
    });

    it("maintenance mode pauses non-admin writes but not reads, admins, or sign-in", async () => {
      const admin = await t.newAdmin();
      const user = await t.signUpAndLogin("citizen@example.com");
      await admin.agent.put(`${t.api}/admin/settings/platform.maintenanceMessage`).send({ value: "Back at 6pm", reason: "Planned database work" });
      await admin.agent.put(`${t.api}/admin/settings/platform.maintenanceMode`).send({ value: true, reason: "Planned database work" });
      const blocked = await user.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Citizen", preferredDivision: "Dhaka" });
      expect(blocked.status).toBe(503);
      expect(blocked.body).toMatchObject({ code: "MAINTENANCE", message: "Back at 6pm" });
      expect((await user.agent.get(`${t.api}/me`)).status).toBe(200);
      expect((await t.client().get(`${t.api}/categories`)).status).toBe(200);
      expect((await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: "citizen@example.com", password: "correct-horse-battery" })).status).toBe(200);
      // admins can still work, in particular switch it off again
      const off = await admin.agent.put(`${t.api}/admin/settings/platform.maintenanceMode`).send({ value: false, reason: "Done" });
      expect(off.status).toBe(200);
      expect((await user.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Citizen", preferredDivision: "Dhaka" })).status).toBe(200);
    });

    it("turns the AI assistant off and on", async () => {
      const admin = await t.newAdmin();
      const user = await t.signUpAndLogin("asker@example.com");
      await admin.agent.put(`${t.api}/admin/settings/ai.assistantEnabled`).send({ value: false, reason: "Rewriting the knowledge base" });
      expect((await t.client().get(`${t.api}/ai/status`)).body.available).toBe(false);
      const chat = await user.agent.post(`${t.api}/ai/chat`).send({ message: "I need an electrician in Dhaka" });
      expect(chat.status).toBe(503);
    });
  });
});
