import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../src/admin/audit/audit.service.js";
import { DEMO_KEYS, demoSettingKey, type DemoKey } from "../src/demo/demo.config.js";
import { demoSession, seedDemoData } from "./demo-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

/**
 * "Demo Access Settings": who may change them, what they do, that they survive a restart, and that a failed change leaves
 * the last confirmed state in place. The two switches per role are independent (docs/DEMO.md).
 */
describe("demo access settings", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetData();
    await seedDemoData(t);
  });

  const put = (agent: { put: (u: string) => { send: (b: object) => Promise<{ status: number; body: Record<string, unknown> }> } }, key: string, value: unknown, reason = "Setting up the demo") =>
    agent.put(`${t.api}/admin/settings/${key}`).send({ value, reason });
  const settings = async (agent: Awaited<ReturnType<TestApp["newAdmin"]>>["agent"]) =>
    new Map(((await agent.get(`${t.api}/admin/settings`)).body.settings as { key: string; value: unknown }[]).map((s) => [s.key, s.value]));
  const options = async (client = t.client()) => (await client.get(`${t.api}/demo/options`)).body.options as { role: string; available: boolean }[];

  it("lists six independent switches under 'Demo access', all off by default", async () => {
    const admin = await t.newAdmin();
    const list = (await admin.agent.get(`${t.api}/admin/settings`)).body.settings as { key: string; group: string; type: string; value: unknown; default: unknown; isDefault: boolean; label: string; description: string }[];
    const demo = list.filter((s) => s.group === "Demo access");
    expect(demo.map((s) => s.key).sort()).toEqual(DEMO_KEYS.flatMap((k) => [demoSettingKey(k, "enabled"), demoSettingKey(k, "visible")]).sort());
    for (const s of demo) {
      expect(s).toMatchObject({ type: "boolean", value: false, default: false, isDefault: true });
      expect(s.label.length).toBeGreaterThan(10);
      expect(s.description.length).toBeGreaterThan(40);
    }
    // never public: the generic public config does not carry them
    expect(JSON.stringify((await t.client().get(`${t.api}/config/platform`)).body)).not.toMatch(/demo/i);
  });

  describe("who may change them", () => {
    it("anonymous visitors and ordinary users cannot read or change the admin settings", async () => {
      expect((await t.client().get(`${t.api}/admin/settings`)).status).toBe(401);
      expect((await put(t.client(), "demo.admin.enabled", true)).status).toBe(401);
      const user = await t.signUpAndLogin("ordinary@example.com");
      expect((await user.agent.get(`${t.api}/admin/settings`)).status).toBe(403);
      const res = await put(user.agent, "demo.admin.enabled", true);
      expect(res.status).toBe(403);
      expect(await t.prisma.platformSetting.findUnique({ where: { key: "demo.admin.enabled" } })).toBeNull();
    });

    it("an administrator without the settings permission can read but not change", async () => {
      const readOnly = await t.newAdminWith(["settings.read"]);
      expect((await readOnly.agent.get(`${t.api}/admin/settings`)).status).toBe(200);
      const res = await put(readOnly.agent, "demo.customer.enabled", true);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PERMISSION_DENIED");
      const none = await t.newAdminWith(["users.read"]);
      expect((await none.agent.get(`${t.api}/admin/settings`)).status).toBe(403);
      expect(await t.prisma.platformSetting.count({ where: { key: { startsWith: "demo." } } })).toBe(0);
    });

    it("an administrator with the permission can change them", async () => {
      const manager = await t.newAdminWith(["settings.read", "settings.manage"]);
      const res = await put(manager.agent, "demo.customer.visible", true, "Show the customer demo");
      expect(res.status).toBe(200);
      expect(res.body.setting).toMatchObject({ key: "demo.customer.visible", value: true, isDefault: false });
    });

    it("the demo administrator can neither read the demo switches nor change any setting", async () => {
      const admin = await t.newAdmin();
      await put(admin.agent, "demo.admin.enabled", true);
      const demoAdmin = await demoSession(t, "admin");
      const visible = await settings(demoAdmin.agent as never);
      expect([...visible.keys()].filter((k) => k.startsWith("demo."))).toEqual([]);
      for (const key of ["demo.admin.enabled", "demo.admin.visible", "demo.customer.enabled", "platform.maintenanceMode"]) {
        const res = await put(demoAdmin.agent, key, true);
        expect([res.status, res.body.code], key).toEqual([403, "DEMO_READ_ONLY"]);
      }
      expect((await settings(admin.agent)).get("demo.customer.enabled")).toBe(false); // nothing it tried took effect
    });
  });

  describe("validation: invalid or unknown updates fail safely", () => {
    it("rejects wrong types, missing or short reasons, extra keys and unknown settings, changing nothing", async () => {
      const admin = await t.newAdmin();
      const bad: [string, object][] = [
        ["demo.admin.enabled", { value: "yes", reason: "Valid reason text" }],
        ["demo.admin.enabled", { value: 1, reason: "Valid reason text" }],
        ["demo.admin.enabled", { value: null, reason: "Valid reason text" }],
        ["demo.admin.enabled", { value: true }],
        ["demo.admin.enabled", { value: true, reason: "x" }],
        ["demo.admin.enabled", { value: true, reason: "Valid reason text", role: "super_admin" }],
        ["demo.guest.enabled", { value: true, reason: "Valid reason text" }],
        ["demo.admin.enabled.extra", { value: true, reason: "Valid reason text" }],
        ["demo.admin", { value: true, reason: "Valid reason text" }],
      ];
      for (const [key, body] of bad) {
        const res = await admin.agent.put(`${t.api}/admin/settings/${encodeURIComponent(key)}`).send(body);
        expect(res.status, `${key} ${JSON.stringify(body)}`).toBe(400);
      }
      expect(await t.prisma.platformSetting.count({ where: { key: { startsWith: "demo." } } })).toBe(0);
      expect(await t.prisma.auditLog.count({ where: { action: "setting.update" } })).toBe(0);
    });

    it("answers 409 for a change to the value it already has", async () => {
      const admin = await t.newAdmin();
      expect((await put(admin.agent, "demo.worker.visible", false)).status).toBe(409);
      expect((await put(admin.agent, "demo.worker.visible", true)).status).toBe(200);
      expect((await put(admin.agent, "demo.worker.visible", true)).status).toBe(409);
    });
  });

  describe("visibility and availability behave independently, for each role", () => {
    it.each(DEMO_KEYS)("%s: all four combinations", async (role: DemoKey) => {
      const admin = await t.newAdmin();
      const set = async (visible: boolean, enabled: boolean) => {
        const current = await settings(admin.agent);
        if (current.get(demoSettingKey(role, "visible")) !== visible) expect((await put(admin.agent, demoSettingKey(role, "visible"), visible)).status).toBe(200);
        if (current.get(demoSettingKey(role, "enabled")) !== enabled) expect((await put(admin.agent, demoSettingKey(role, "enabled"), enabled)).status).toBe(200);
      };
      const start = async () => (await t.client().post(`${t.api}/auth/demo/sign-in`).send({ role })).status;
      const listed = async () => (await options()).find((o) => o.role === role);

      await set(false, false);
      expect([await listed(), await start()]).toEqual([undefined, 403]);
      await set(true, false);
      expect([await listed(), await start()]).toEqual([{ role, available: false, label: expect.any(String), description: expect.any(String) }, 403]);
      await set(false, true);
      expect([await listed(), await start()]).toEqual([undefined, 200]); // hidden, yet reachable by a direct request: hidden is not disabled
      await set(true, true);
      expect([await listed(), await start()]).toEqual([{ role, available: true, label: expect.any(String), description: expect.any(String) }, 200]);
      // the other roles were never touched
      for (const other of DEMO_KEYS.filter((k) => k !== role)) expect((await options()).find((o) => o.role === other)).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("survives a restart: a new application instance on the same database reads the same settings", async () => {
      const admin = await t.newAdmin();
      await put(admin.agent, "demo.customer.visible", true);
      await put(admin.agent, "demo.customer.enabled", true);
      await put(admin.agent, "demo.admin.visible", true);
      const restarted = await createTestApp();
      try {
        expect((await options(restarted.client())).map((o) => [o.role, o.available])).toEqual([["customer", true], ["admin", false]]);
        const again = await restarted.client().post(`${restarted.api}/auth/demo/sign-in`).send({ role: "customer" });
        expect(again.status).toBe(200);
        const row = await restarted.prisma.platformSetting.findUniqueOrThrow({ where: { key: "demo.customer.enabled" } });
        expect(row.value).toBe(true);
        expect(row.updatedById).toBe(admin.userId);
      } finally {
        await restarted.close();
      }
    });

    it("keeps the last confirmed value when an update fails part-way (the change and its audit row commit together)", async () => {
      const admin = await t.newAdmin();
      expect((await put(admin.agent, "demo.worker.enabled", true)).status).toBe(200);
      const audit = t.app.get(AuditService);
      const original = audit.record.bind(audit);
      audit.record = (() => Promise.reject(new Error("audit store is down"))) as unknown as typeof audit.record;
      try {
        const res = await put(admin.agent, "demo.worker.enabled", false, "This one must fail");
        expect(res.status).toBe(500);
      } finally {
        audit.record = original;
      }
      expect((await settings(admin.agent)).get("demo.worker.enabled")).toBe(true); // rolled back: still the confirmed value
      expect((await t.client().post(`${t.api}/auth/demo/sign-in`).send({ role: "worker" })).status).toBe(200); // and still in force
      expect(await t.prisma.auditLog.count({ where: { action: "setting.update", targetId: "demo.worker.enabled" } })).toBe(1);
    });
  });

  describe("audit", () => {
    it("records who changed what, when and why, and nothing secret", async () => {
      const admin = await t.newAdmin();
      const before = Date.now();
      await put(admin.agent, "demo.admin.enabled", true, "Showing the demo to the review board");
      await put(admin.agent, "demo.admin.enabled", false, "Review finished");
      const rows = await t.prisma.auditLog.findMany({ where: { action: "setting.update", targetId: "demo.admin.enabled" }, orderBy: { seq: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actorId: admin.userId, targetType: "PlatformSetting", targetId: "demo.admin.enabled" });
      expect(rows[0]!.metadata).toMatchObject({ from: false, to: true, reason: "Showing the demo to the review board" });
      expect(rows[1]!.metadata).toMatchObject({ from: true, to: false, reason: "Review finished" });
      expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      const text = JSON.stringify(rows.map((r) => r.metadata));
      expect(text).not.toMatch(/password|secret|token|cookie|BETTER_AUTH/i);
      // disabling also recorded how many demo visitors were signed out
      const ended = await t.prisma.auditLog.findMany({ where: { action: "demo.sessions_end" } });
      expect(ended).toHaveLength(1);
      expect(ended[0]!.metadata).toMatchObject({ role: "admin", signedOutVisitors: 0 });
      // the trail itself is intact
      expect((await admin.agent.get(`${t.api}/admin/audit/verify`)).body).toMatchObject({ valid: true });
    });
  });
});
