import { ModulesContainer } from "@nestjs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DEFAULT_ROLES, expandPermissions } from "../src/admin/permissions.js";
import { REQUIRED_PERMISSIONS } from "../src/auth/permission.guard.js";
import { createTestApp, PASSWORD, uniqueEmail, type TestApp } from "./helpers.js";

/** Walks the real controllers (not the router) so permission metadata can be read per handler. */
function adminRoutes(t: TestApp) {
  const out: { method: string; path: string; permissions: string[] | undefined }[] = [];
  const http = { 0: "GET", 1: "POST", 2: "PUT", 3: "DELETE", 4: "PATCH" } as Record<number, string>;
  for (const mod of t.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!cls) continue;
      const base = String(Reflect.getMetadata("path", cls) ?? "");
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        const sub = Reflect.getMetadata("path", handler) as string | string[] | undefined;
        const verb = Reflect.getMetadata("method", handler) as number | undefined;
        if (sub === undefined || verb === undefined) continue;
        for (const s of Array.isArray(sub) ? sub : [sub]) {
          const path = `/${[base, s === "/" ? "" : s].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
          const permissions = (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? Reflect.getMetadata(REQUIRED_PERMISSIONS, cls)) as string[] | undefined;
          out.push({ method: http[verb]!, path, permissions });
        }
      }
    }
  }
  return out.filter((r) => r.path.startsWith("/admin/"));
}

describe("admin RBAC", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  describe("structure", () => {
    it("every /admin route declares the permissions it needs, and every permission guards at least one route", () => {
      const routes = adminRoutes(t);
      expect(routes.length).toBeGreaterThan(40);
      const naked = routes.filter((r) => !r.permissions || r.permissions.length === 0).map((r) => `${r.method} ${r.path}`);
      expect(naked).toEqual([]);
      const used = new Set(routes.flatMap((r) => r.permissions ?? []));
      expect(ALL_PERMISSIONS.filter((p) => !used.has(p))).toEqual([]);
      for (const p of used) expect(ALL_PERMISSIONS as string[]).toContain(p);
    });

    it("default roles only use real permissions", () => {
      for (const role of DEFAULT_ROLES) for (const p of role.permissions) expect(ALL_PERMISSIONS as string[]).toContain(p);
    });

    it("super_admin exists with the wildcard, is a system role and cannot be changed even by SQL", async () => {
      const role = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      expect(role).toMatchObject({ isSystem: true, permissions: ["*"] });
      expect(expandPermissions(role.permissions).size).toBe(ALL_PERMISSIONS.length);
      await expect(t.prisma.adminRole.update({ where: { id: role.id }, data: { name: "x" } })).rejects.toThrow(/system admin roles/);
      await expect(t.prisma.adminRole.delete({ where: { id: role.id } })).rejects.toThrow(/system admin roles/);
    });
  });

  describe("enforcement on direct API requests", () => {
    it("answers 401 without a session and 403 to an ordinary user, for every admin route", async () => {
      const user = await t.signUpAndLogin("plain@example.com");
      const offenders: string[] = [];
      for (const r of adminRoutes(t)) {
        const url = `${t.api}${r.path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000")}`;
        const anon = await (t.client() as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number }> }>)[r.method.toLowerCase()]!(url).send(r.method === "GET" ? undefined : {});
        const plain = await (user.agent as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number }> }>)[r.method.toLowerCase()]!(url).send(r.method === "GET" ? undefined : {});
        if (anon.status !== 401) offenders.push(`anon ${r.method} ${r.path} -> ${anon.status}`);
        if (plain.status !== 403) offenders.push(`user ${r.method} ${r.path} -> ${plain.status}`);
      }
      expect(offenders).toEqual([]);
    });

    it("an ADMIN with no role has no permissions at all (fails closed)", async () => {
      const u = await t.signUpAndLogin("roleless@example.com");
      await t.prisma.user.update({ where: { id: u.userId }, data: { role: "ADMIN" } });
      const offenders: string[] = [];
      for (const r of adminRoutes(t)) {
        const url = `${t.api}${r.path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000")}`;
        const res = await (u.agent as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number }> }>)[r.method.toLowerCase()]!(url).send(r.method === "GET" ? undefined : {});
        if (res.status !== 403) offenders.push(`${r.method} ${r.path} -> ${res.status}`);
      }
      expect(offenders).toEqual([]);
    });

    it("a limited admin can use exactly the permissions of their role and nothing else", async () => {
      const a = await t.newAdminWith(["users.read", "audit.read"]);
      expect((await a.agent.get(`${t.api}/admin/users`)).status).toBe(200);
      expect((await a.agent.get(`${t.api}/admin/audit`)).status).toBe(200);
      expect((await a.agent.get(`${t.api}/admin/roles`)).status).toBe(403); // roles.read missing
      expect((await a.agent.get(`${t.api}/admin/audit/verify`)).status).toBe(403); // audit.read does not include verify
      expect((await a.agent.get(`${t.api}/admin/payments`)).status).toBe(403);
      const target = await t.signUpAndLogin("target@example.com");
      const res = await a.agent.post(`${t.api}/admin/users/${target.userId}/suspension`).send({ suspended: true, reason: "no", confirm: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PERMISSION_DENIED");
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).suspendedAt).toBeNull();
    });

    it("a role change takes effect on the very next request", async () => {
      const a = await t.newAdminWith(["users.read"]);
      expect((await a.agent.get(`${t.api}/admin/users`)).status).toBe(200);
      await t.prisma.adminRole.update({ where: { id: a.roleId }, data: { permissions: ["audit.read"] } });
      expect((await a.agent.get(`${t.api}/admin/users`)).status).toBe(403);
      expect((await a.agent.get(`${t.api}/admin/audit`)).status).toBe(200);
    });

    it("permissions removed from the code catalogue are ignored even if still stored on a role", async () => {
      const a = await t.newAdminWith(["users.read", "legacy.permission.removed"]);
      expect((await a.agent.get(`${t.api}/admin/users`)).status).toBe(200);
      const me = await a.agent.get(`${t.api}/me`);
      expect(me.body.admin.permissions).toEqual(["users.read"]);
    });

    it("GET /me tells the UI what the admin may do, and nothing to a plain user", async () => {
      const root = await t.newAdmin();
      const me = await root.agent.get(`${t.api}/me`);
      expect(me.body.isAdmin).toBe(true);
      expect(me.body.admin.role.key).toBe("super_admin");
      expect(me.body.admin.permissions.length).toBe(ALL_PERMISSIONS.length);
      const plain = await t.signUpAndLogin("p2@example.com");
      expect((await plain.agent.get(`${t.api}/me`)).body.admin).toBeNull();
    });
  });

  describe("nobody can grant themselves admin", () => {
    it("ignores role fields at sign-up and profile update", async () => {
      const agent = t.client();
      const email = uniqueEmail("sneaky");
      const reg = await agent.post(`${t.api}/auth/sign-up/email`).send({ name: "Sneaky", email, password: PASSWORD, role: "ADMIN", adminRoleId: "x" });
      expect([200, 400, 422]).toContain(reg.status);
      const otp = t.lastOtp(email);
      if (otp) await agent.post(`${t.api}/auth/email-otp/verify-email`).send({ email, otp, password: PASSWORD });
      const row = await t.prisma.user.findUnique({ where: { email } });
      if (row) expect(row).toMatchObject({ role: "USER", adminRoleId: null });
      await agent.post(`${t.api}/auth/update-user`).send({ role: "ADMIN", adminRoleId: "x", name: "Still Sneaky" });
      const after = await t.prisma.user.findUnique({ where: { email } });
      if (after) expect(after).toMatchObject({ role: "USER", adminRoleId: null });
    });

    it("an ordinary user and a limited admin cannot assign admin access", async () => {
      const plain = await t.signUpAndLogin("grantee@example.com");
      const role = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      const body = { roleId: role.id, reason: "please", confirm: true };
      expect((await plain.agent.post(`${t.api}/admin/users/${plain.userId}/admin-access`).send(body)).status).toBe(403);
      const limited = await t.newAdminWith(["users.read", "roles.read"]);
      expect((await limited.agent.post(`${t.api}/admin/users/${plain.userId}/admin-access`).send(body)).status).toBe(403);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: plain.userId } })).role).toBe("USER");
    });
  });

  describe("roles", () => {
    it("creates, edits and deletes a role, auditing each step", async () => {
      const root = await t.newAdmin();
      const created = await root.agent.post(`${t.api}/admin/roles`).send({ key: "ticket_triage", name: "Ticket triage", description: "Reads tickets", permissions: ["support.read", "dashboard.view"] });
      expect(created.status).toBe(201);
      const id = created.body.role.id as string;
      expect(created.body.role.permissions).toEqual(["dashboard.view", "support.read"]);
      const edited = await root.agent.patch(`${t.api}/admin/roles/${id}`).send({ permissions: ["support.read", "support.manage"] });
      expect(edited.status).toBe(200);
      const bad = await root.agent.delete(`${t.api}/admin/roles/${id}`).send({ confirmKey: "wrong" });
      expect(bad.status).toBe(409);
      expect((await root.agent.delete(`${t.api}/admin/roles/${id}`).send({ confirmKey: "ticket_triage" })).status).toBe(200);
      const actions = (await t.prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(actions).toEqual(["role.create", "role.update", "role.delete"]);
      const upd = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "role.update" } });
      expect(upd.actorId).toBe(root.userId);
      expect(upd.metadata).toMatchObject({ key: "ticket_triage", added: ["support.manage"], removed: ["dashboard.view"] });
    });

    it("validates input: unknown permission, wildcard, bad key, empty list, extra fields", async () => {
      const root = await t.newAdmin();
      const post = (b: object) => root.agent.post(`${t.api}/admin/roles`).send(b);
      const ok = { key: "valid_key", name: "Valid", description: "d", permissions: ["users.read"] };
      expect((await post({ ...ok, permissions: ["users.read", "made.up"] })).status).toBe(400);
      expect((await post({ ...ok, permissions: ["*"] })).status).toBe(400);
      expect((await post({ ...ok, permissions: [] })).status).toBe(400);
      expect((await post({ ...ok, key: "Bad Key" })).status).toBe(400);
      expect((await post({ ...ok, key: "x" })).status).toBe(400);
      expect((await post({ ...ok, isSystem: true })).status).toBe(400);
      expect((await post(ok)).status).toBe(201);
      expect((await post(ok)).status).toBe(409); // duplicate key
    });

    it("blocks escalation: cannot create or edit a role with permissions you do not hold", async () => {
      const mid = await t.newAdminWith(["roles.read", "roles.manage", "users.read"]);
      const tooMuch = await mid.agent.post(`${t.api}/admin/roles`).send({ key: "escalate", name: "Escalate", description: "d", permissions: ["users.read", "payments.read"] });
      expect(tooMuch.status).toBe(403);
      expect(tooMuch.body.code).toBe("PERMISSION_ESCALATION");
      const fine = await mid.agent.post(`${t.api}/admin/roles`).send({ key: "within", name: "Within", description: "d", permissions: ["users.read"] });
      expect(fine.status).toBe(201);
      const grow = await mid.agent.patch(`${t.api}/admin/roles/${fine.body.role.id}`).send({ permissions: ["users.read", "refunds.process"] });
      expect(grow.status).toBe(403);
      // a role more powerful than the editor cannot be edited or deleted by them
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      expect((await mid.agent.patch(`${t.api}/admin/roles/${finance.id}`).send({ name: "Renamed" })).body.code).toBe("ROLE_TOO_POWERFUL");
      expect((await mid.agent.delete(`${t.api}/admin/roles/${finance.id}`).send({ confirmKey: "finance_admin" })).status).toBe(403);
    });

    it("refuses to edit or delete system roles, and to delete a role that still has holders", async () => {
      const root = await t.newAdmin();
      const sup = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      expect((await root.agent.patch(`${t.api}/admin/roles/${sup.id}`).send({ name: "Mine now" })).status).toBe(409);
      expect((await root.agent.delete(`${t.api}/admin/roles/${sup.id}`).send({ confirmKey: "super_admin" })).status).toBe(409);
      const held = await t.newAdmin("support_agent");
      const role = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "support_agent" } });
      const del = await root.agent.delete(`${t.api}/admin/roles/${role.id}`).send({ confirmKey: "support_agent" });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe("ROLE_IN_USE");
      expect(held.userId).toBeDefined();
    });

    it("lists the permission catalogue and role holders", async () => {
      const root = await t.newAdmin();
      const cat = await root.agent.get(`${t.api}/admin/roles/permissions`);
      expect(cat.status).toBe(200);
      expect(cat.body.groups.flatMap((g: { permissions: unknown[] }) => g.permissions)).toHaveLength(ALL_PERMISSIONS.length);
      const list = await root.agent.get(`${t.api}/admin/roles`);
      const sup = list.body.roles.find((r: { key: string }) => r.key === "super_admin");
      expect(sup).toMatchObject({ isSystem: true, holders: 1, permissions: ["*"] });
      expect(sup.effectivePermissions).toHaveLength(ALL_PERMISSIONS.length);
      const detail = await root.agent.get(`${t.api}/admin/roles/${sup.id}`);
      expect(detail.body.role.users[0]).toMatchObject({ id: root.userId });
    });
  });

  describe("assigning admin access", () => {
    it("grants, changes and revokes a role, with audit entries and preconditions", async () => {
      const root = await t.newAdmin();
      const person = await t.signUpAndLogin("promote@example.com");
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      const grant = await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: finance.id, reason: "joins finance", confirm: true });
      expect(grant.status).toBe(200);
      expect(grant.body.user).toMatchObject({ role: "ADMIN", adminRole: { key: "finance_admin" } });
      expect((await person.agent.get(`${t.api}/admin/payments`)).status).toBe(200);
      expect((await person.agent.get(`${t.api}/admin/users`)).status).toBe(403);

      const support = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "support_agent" } });
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: support.id, reason: "moves to support", confirm: true })).status).toBe(200);
      expect((await person.agent.get(`${t.api}/admin/payments`)).status).toBe(403);
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: support.id, reason: "again", confirm: true })).status).toBe(409);

      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: null, reason: "left the team", confirm: true })).status).toBe(200);
      expect(await t.prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).toMatchObject({ role: "USER", adminRoleId: null });
      expect((await person.agent.get(`${t.api}/admin/users`)).status).toBe(403);

      const trail = await t.prisma.auditLog.findMany({ where: { targetType: "User", targetId: person.userId }, orderBy: { seq: "asc" } });
      expect(trail.map((r) => r.action)).toEqual(["admin.grant", "admin.change_role", "admin.revoke"]);
      expect(trail.every((r) => r.actorId === root.userId)).toBe(true);
      expect(trail[1]!.metadata).toMatchObject({ from: "finance_admin", to: "support_agent", reason: "moves to support" });
    });

    it("requires confirmation and a reason", async () => {
      const root = await t.newAdmin();
      const person = await t.signUpAndLogin("noconfirm@example.com");
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: finance.id, reason: "ok" })).status).toBe(400);
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: finance.id, reason: "", confirm: true })).status).toBe(400);
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: "nope", reason: "ok", confirm: true })).status).toBe(400);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).role).toBe("USER");
    });

    it("forbids changing your own access, assigning a more powerful role, or touching a more powerful admin", async () => {
      const assigner = await t.newAdminWith(["admins.assign", "users.read", "roles.read"]);
      const other = await t.signUpAndLogin("target2@example.com");
      const sup = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      expect((await assigner.agent.post(`${t.api}/admin/users/${assigner.userId}/admin-access`).send({ roleId: null, reason: "bye", confirm: true })).body.code).toBe("SELF_ACTION");
      expect((await assigner.agent.post(`${t.api}/admin/users/${other.userId}/admin-access`).send({ roleId: sup.id, reason: "because", confirm: true })).body.code).toBe("ROLE_TOO_POWERFUL");
      expect((await assigner.agent.post(`${t.api}/admin/users/${other.userId}/admin-access`).send({ roleId: finance.id, reason: "because", confirm: true })).body.code).toBe("ROLE_TOO_POWERFUL");
      const boss = await t.newAdmin();
      expect((await assigner.agent.post(`${t.api}/admin/users/${boss.userId}/admin-access`).send({ roleId: null, reason: "coup", confirm: true })).body.code).toBe("TARGET_TOO_POWERFUL");
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: boss.userId } })).role).toBe("ADMIN");
    });

    it("only a super administrator can hand out super_admin, even to someone who holds every permission", async () => {
      const everything = await t.newAdminWith([...ALL_PERMISSIONS]);
      const person = await t.signUpAndLogin("wouldbe@example.com");
      const sup = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      const res = await everything.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: sup.id, reason: "because", confirm: true });
      expect(res.status).toBe(403);
      const root = await t.newAdmin();
      expect((await root.agent.post(`${t.api}/admin/users/${person.userId}/admin-access`).send({ roleId: sup.id, reason: "second admin", confirm: true })).status).toBe(200);
    });

    it("never promotes an unverified or suspended account", async () => {
      const root = await t.newAdmin();
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      const unverified = await t.signUpAndLogin("unv@example.com");
      await t.prisma.user.update({ where: { id: unverified.userId }, data: { emailVerified: false } });
      expect((await root.agent.post(`${t.api}/admin/users/${unverified.userId}/admin-access`).send({ roleId: finance.id, reason: "because", confirm: true })).body.code).toBe("EMAIL_NOT_VERIFIED");
      const sus = await t.signUpAndLogin("sus@example.com");
      await root.agent.post(`${t.api}/admin/users/${sus.userId}/suspension`).send({ suspended: true, reason: "abuse", confirm: true });
      expect((await root.agent.post(`${t.api}/admin/users/${sus.userId}/admin-access`).send({ roleId: finance.id, reason: "because", confirm: true })).body.code).toBe("USER_SUSPENDED");
    });

    it("protects the last super administrator from demotion and suspension (API and database)", async () => {
      const only = await t.newAdmin();
      const second = await t.newAdmin("operations_admin");
      const sup = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      // the database trigger is the backstop even for code paths that skip the service
      await expect(t.prisma.user.update({ where: { id: only.userId }, data: { role: "USER", adminRoleId: null } })).rejects.toThrow(/last active super administrator/);
      await expect(t.prisma.user.update({ where: { id: only.userId }, data: { suspendedAt: new Date(), suspensionReason: "x" } })).rejects.toThrow(/last active super administrator/);
      // with a second super admin the first may step down
      const root2 = await t.signUpAndLogin("root2@example.com");
      await t.makeAdmin(root2.userId);
      const demote = await root2.agent.post(`${t.api}/admin/users/${only.userId}/admin-access`).send({ roleId: null, reason: "rotation", confirm: true });
      expect(demote.status).toBe(200);
      // ... and now root2 is the last one
      const hold = await t.newAdmin();
      await t.prisma.user.update({ where: { id: hold.userId }, data: { role: "USER", adminRoleId: null } });
      await expect(t.prisma.user.update({ where: { id: root2.userId }, data: { role: "USER", adminRoleId: null } })).rejects.toThrow(/last active/);
      expect(second.userId).toBeDefined();
      expect(sup.id).toBeDefined();
    });

    it("keeps the CHECK constraint: a non-admin can never hold a role", async () => {
      const u = await t.signUpAndLogin("check@example.com");
      const finance = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "finance_admin" } });
      await expect(t.prisma.user.update({ where: { id: u.userId }, data: { adminRoleId: finance.id } })).rejects.toThrow();
    });
  });
});
