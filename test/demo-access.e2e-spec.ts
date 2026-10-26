import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ADMIN_PERMISSIONS, DEMO_PROFILES, DEMO_SESSION_SECONDS, DEMO_MAX_SESSIONS_PER_ROLE } from "../src/demo/demo.config.js";
import { allDemoOn, demoSession, demoSignIn, seedDemoData, setDemoSwitches } from "./demo-helpers.js";
import { createTestApp, WEB_ORIGIN, type TestApp } from "./helpers.js";

/**
 * "Continue as Demo Customer / Worker / Admin": how a visitor gets a session, what the administrator's two switches do,
 * and what a demo session may not do to its own account. docs/DEMO.md.
 */
describe("demo login", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetData();
    await seedDemoData(t);
  });

  const options = async () => (await t.client().get(`${t.api}/demo/options`)).body.options as { role: string; label: string; description: string; available: boolean }[];
  const sessionCount = (email: string) => t.prisma.unscoped.session.count({ where: { user: { email } } });

  describe("the public options (what the login page may show)", () => {
    it("shows nothing by default: demo access is opt-in", async () => {
      expect(await options()).toEqual([]);
    });

    it("lists only the options an administrator made visible, each with a description", async () => {
      await setDemoSwitches(t, { customer: { visible: true, enabled: true }, worker: { visible: true, enabled: true }, admin: { visible: false, enabled: true } });
      const list = await options();
      expect(list.map((o) => o.role)).toEqual(["customer", "worker"]);
      expect(list[0]).toEqual({ role: "customer", label: "Demo Customer", description: DEMO_PROFILES.customer.description, available: true });
      expect(list.every((o) => o.description.length > 20)).toBe(true);
    });

    it("shows all three when all are visible and enabled", async () => {
      await setDemoSwitches(t, allDemoOn);
      expect((await options()).map((o) => o.role)).toEqual(["customer", "worker", "admin"]);
    });

    it("hides each option independently when its visibility is switched off", async () => {
      for (const hidden of ["customer", "worker", "admin"] as const) {
        await setDemoSwitches(t, { ...allDemoOn, [hidden]: { visible: false, enabled: true } });
        const roles = (await options()).map((o) => o.role);
        expect(roles).not.toContain(hidden);
        expect(roles).toHaveLength(2);
      }
    });

    it("lists a visible but disabled option as unavailable (so the page can say so), never as available", async () => {
      await setDemoSwitches(t, { admin: { visible: true, enabled: false } });
      expect(await options()).toEqual([expect.objectContaining({ role: "admin", available: false })]);
    });

    it("exposes nothing else: no user, id, email, setting key or hint of a hidden option", async () => {
      await setDemoSwitches(t, { customer: { visible: true, enabled: true }, admin: { visible: false, enabled: true } });
      const res = await t.client().get(`${t.api}/demo/options`);
      const text = JSON.stringify(res.body);
      expect(Object.keys(res.body)).toEqual(["options"]);
      expect(text).not.toMatch(/demo\.fixeditnow\.invalid|demo\.(customer|worker|admin)\.|Demo Admin|userId|"id"/);
      expect(res.headers["cache-control"]).toContain("no-store");
    });

    it("is public (no session needed) and does not change the public platform config", async () => {
      expect((await t.client().get(`${t.api}/demo/options`)).status).toBe(200);
      await setDemoSwitches(t, allDemoOn);
      const config = (await t.client().get(`${t.api}/config/platform`)).body;
      expect(JSON.stringify(config)).not.toMatch(/demo/i);
    });
  });

  describe("starting a session", () => {
    it("is refused for every role while the backend switch is off (the default)", async () => {
      for (const role of ["customer", "worker", "admin"]) {
        const { res, agent } = await demoSignIn(t, role);
        expect(res.status, role).toBe(403);
        expect(res.body.code).toBe("DEMO_DISABLED");
        expect((await agent.get(`${t.api}/me`)).status).toBe(401);
      }
      expect(await t.prisma.unscoped.session.count()).toBe(0);
    });

    it("works for each role once enabled, and the session carries the right role and permissions", async () => {
      await setDemoSwitches(t, allDemoOn);
      const customer = await demoSession(t, "customer");
      expect(customer.me).toMatchObject({ isAdmin: false, admin: null, demo: { role: "customer" }, user: { email: DEMO_PROFILES.customer.email } });
      const worker = await demoSession(t, "worker");
      expect(worker.me).toMatchObject({ isAdmin: false, demo: { role: "worker" }, user: { email: DEMO_PROFILES.worker.email }, worker: { started: true, approved: true } });
      const admin = await demoSession(t, "admin");
      expect(admin.me).toMatchObject({ isAdmin: true, demo: { role: "admin" }, user: { email: DEMO_PROFILES.admin.email }, admin: { role: { key: "demo_admin" } } });
      // read-only permissions only: never the real super administrator's "everything"
      expect([...(admin.me.admin.permissions as string[])].sort((a, b) => a.localeCompare(b))).toEqual([...DEMO_ADMIN_PERMISSIONS].sort((a, b) => a.localeCompare(b)));
    });

    it("returns where to go and no token; the session cookie is HttpOnly, SameSite=Lax and ends with the browser session", async () => {
      await setDemoSwitches(t, allDemoOn);
      const { res } = await demoSignIn(t, "customer");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ role: "customer", redirectTo: "/account" });
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
      const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.includes("session_token"))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Max-Age|Expires/i); // a browser-session cookie: gone when the browser closes
      expect((await demoSignIn(t, "worker")).res.body.redirectTo).toBe("/bookings?role=worker");
      expect((await demoSignIn(t, "admin")).res.body.redirectTo).toBe("/admin");
    });

    it("marks the cookie Secure in production", async () => {
      const prod = await createTestApp({ NODE_ENV: "production", RATE_LIMIT_ENABLED: "true", TRUSTED_PROXIES: "127.0.0.1", SMTP_HOST: "smtp.example.test", MAIL_TRANSPORT: "smtp", BETTER_AUTH_URL: "https://app.example.test", FRONTEND_ORIGIN: "https://app.example.test" });
      try {
        await setDemoSwitches(prod, allDemoOn);
        const res = await request(prod.app.getHttpServer()).post(`${prod.api}/auth/demo/sign-in`).set("Origin", "https://app.example.test").send({ role: "customer" });
        expect(res.status).toBe(200);
        const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.includes("session_token"))!;
        expect(cookie).toMatch(/Secure/i);
        expect(cookie).toMatch(/HttpOnly/i);
      } finally {
        await prod.close();
      }
    });

    it("creates a short-lived server-side session for the fixed demo user", async () => {
      await setDemoSwitches(t, allDemoOn);
      const before = Date.now();
      await demoSession(t, "worker");
      const row = await t.prisma.unscoped.session.findFirstOrThrow({ where: { user: { email: DEMO_PROFILES.worker.email } } });
      const ttl = row.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan((DEMO_SESSION_SECONDS - 60) * 1000);
      expect(ttl).toBeLessThanOrEqual(DEMO_SESSION_SECONDS * 1000 + 5_000);
    });

    it("cannot be pointed at another account or a bigger role: the body names a role and nothing else", async () => {
      await setDemoSwitches(t, allDemoOn);
      const realAdmin = await t.newAdmin();
      const attempts: object[] = [
        { role: "super_admin" }, { role: "ADMIN" }, { role: "owner" }, { role: "" }, { role: ["admin"] }, {},
        { role: "admin", userId: realAdmin.userId }, { role: "customer", email: realAdmin.email }, { role: "customer", adminRole: "super_admin" },
        { role: "customer", isAdmin: true }, { role: "worker", permissions: ["*"] },
      ];
      for (const body of attempts) {
        const agent = t.client();
        const res = await agent.post(`${t.api}/auth/demo/sign-in`).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect((await agent.get(`${t.api}/me`)).status).toBe(401);
      }
      // the only way to ask for the admin role is its name, and it always yields the dedicated demo identity
      const { agent } = await demoSignIn(t, "admin");
      const me = (await agent.get(`${t.api}/me`)).body;
      expect(me.user.email).toBe(DEMO_PROFILES.admin.email);
      expect(me.user.id).not.toBe(realAdmin.userId);
      expect(me.admin.role.key).toBe("demo_admin");
    });

    it("refuses a request from another origin (CSRF) and without a JSON role", async () => {
      await setDemoSwitches(t, allDemoOn);
      const cross = await request(t.app.getHttpServer()).post(`${t.api}/auth/demo/sign-in`).set("Origin", "https://evil.example").send({ role: "customer" });
      expect(cross.status).toBe(403);
      expect(cross.headers["set-cookie"]).toBeUndefined();
      const res = await t.client().post(`${t.api}/auth/demo/sign-in`).send();
      expect(res.status).toBe(400);
    });

    it("answers 503 (not a crash) when the demo data was never seeded", async () => {
      await t.resetData(); // no seed
      await setDemoSwitches(t, allDemoOn);
      const { res } = await demoSignIn(t, "customer");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DEMO_UNAVAILABLE");
    });

    it("never creates a second session for someone already inside the same demo, and tells others to log out first", async () => {
      await setDemoSwitches(t, allDemoOn);
      const { agent } = await demoSession(t, "customer");
      expect(await sessionCount(DEMO_PROFILES.customer.email)).toBe(1);
      const again = await agent.post(`${t.api}/auth/demo/sign-in`).send({ role: "customer" });
      expect(again.status).toBe(200);
      expect(await sessionCount(DEMO_PROFILES.customer.email)).toBe(1); // repeated clicks do not pile up sessions

      const other = await agent.post(`${t.api}/auth/demo/sign-in`).send({ role: "admin" });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe("ALREADY_SIGNED_IN");
      expect((await agent.get(`${t.api}/me`)).body.demo.role).toBe("customer"); // still the demo customer, not upgraded

      const real = await t.signUpAndLogin("real.person@example.com");
      const fromReal = await real.agent.post(`${t.api}/auth/demo/sign-in`).send({ role: "admin" });
      expect(fromReal.status).toBe(409);
      expect((await real.agent.get(`${t.api}/me`)).body.demo).toBeNull(); // a real user's session is never replaced
    });

    it("caps live sessions per role and sweeps expired demo sessions", async () => {
      await setDemoSwitches(t, allDemoOn);
      const customer = await t.prisma.unscoped.user.findUniqueOrThrow({ where: { email: DEMO_PROFILES.customer.email } });
      const future = new Date(Date.now() + 3_600_000);
      await t.prisma.unscoped.session.createMany({
        data: Array.from({ length: DEMO_MAX_SESSIONS_PER_ROLE }, (_, i) => ({ id: `cap-${i}`, token: `cap-token-${i}`, userId: customer.id, expiresAt: future, updatedAt: new Date() })),
      });
      const busy = await demoSignIn(t, "customer");
      expect(busy.res.status).toBe(503);
      expect(busy.res.body.code).toBe("DEMO_BUSY");
      // the cap is per role: the worker is unaffected
      expect((await demoSignIn(t, "worker")).res.status).toBe(200);

      await t.prisma.unscoped.session.updateMany({ where: { userId: customer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await demoSignIn(t, "customer")).res.status).toBe(200);
      expect(await t.prisma.unscoped.session.count({ where: { userId: customer.id } })).toBe(1); // the expired ones were swept
    });
  });

  describe("the administrator's switches on sessions that already exist", () => {
    it("switching a role off ends its open sessions at once (even without the cleanup), and refuses new ones", async () => {
      await setDemoSwitches(t, allDemoOn);
      const a = await demoSession(t, "customer");
      const b = await demoSession(t, "customer");
      const worker = await demoSession(t, "worker");
      const admin = await t.newAdmin();
      const res = await admin.agent.put(`${t.api}/admin/settings/demo.customer.enabled`).send({ value: false, reason: "Demo maintenance" });
      expect(res.status).toBe(200);
      for (const s of [a, b]) {
        const me = await s.agent.get(`${t.api}/me`);
        expect(me.status).toBe(401);
      }
      expect(await sessionCount(DEMO_PROFILES.customer.email)).toBe(0);
      expect((await worker.agent.get(`${t.api}/me`)).status).toBe(200); // other roles untouched
      expect((await demoSignIn(t, "customer")).res.body.code).toBe("DEMO_DISABLED");
      // the change and the sign-outs are both in the audit trail
      const actions = (await t.prisma.auditLog.findMany({ orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["setting.update", "demo.sessions_end"]));
    });

    it("refuses a still-stored session of a disabled role (the check does not depend on the cleanup)", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "worker");
      await setDemoSwitches(t, { ...allDemoOn, worker: { visible: true, enabled: false } }); // direct write: no cleanup ran
      const res = await s.agent.get(`${t.api}/me`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("DEMO_DISABLED");
      expect(await sessionCount(DEMO_PROFILES.worker.email)).toBe(1); // proves the row was still there
    });

    it("hiding an option changes nothing about open sessions or about the backend switch", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "admin");
      const admin = await t.newAdmin();
      expect((await admin.agent.put(`${t.api}/admin/settings/demo.admin.visible`).send({ value: false, reason: "Hide from the page" })).status).toBe(200);
      expect((await s.agent.get(`${t.api}/me`)).status).toBe(200);
      expect((await options()).map((o) => o.role)).not.toContain("admin");
      // hidden is not disabled: a direct request still works while the backend switch is on...
      expect((await demoSignIn(t, "admin")).res.status).toBe(200);
      // ...and a hidden option can never bypass a disabled backend switch
      await setDemoSwitches(t, { admin: { visible: false, enabled: false } });
      expect((await demoSignIn(t, "admin")).res.status).toBe(403);
      await setDemoSwitches(t, { admin: { visible: true, enabled: false } });
      expect((await demoSignIn(t, "admin")).res.status).toBe(403);
    });
  });

  describe("leaving, expiring and rate limiting", () => {
    it("log out ends the session: a copy of its cookie is useless afterwards", async () => {
      await setDemoSwitches(t, allDemoOn);
      const { agent, res } = await demoSignIn(t, "customer");
      const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.includes("session_token"))!.split(";")[0]!;
      const asCopy = () => request(t.app.getHttpServer()).get(`${t.api}/me`).set("Cookie", cookie);
      expect((await asCopy()).status).toBe(200);
      expect((await agent.post(`${t.api}/auth/sign-out`).send({})).status).toBe(200);
      expect((await agent.get(`${t.api}/me`)).status).toBe(401);
      expect((await asCopy()).status).toBe(401);
      expect(await sessionCount(DEMO_PROFILES.customer.email)).toBe(0);
    });

    it("a session past its expiry is rejected", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "customer");
      await t.prisma.unscoped.session.updateMany({ where: { userId: s.userId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      expect((await s.agent.get(`${t.api}/me`)).status).toBe(401);
      expect((await s.agent.get(`${t.api}/bookings?role=customer`)).status).toBe(401);
    });

    it("anonymous requests reach no protected API or dashboard data", async () => {
      await setDemoSwitches(t, allDemoOn);
      for (const path of ["/me", "/bookings", "/payments", "/admin/dashboard", "/admin/users", "/community/posts"]) {
        expect((await t.client().get(`${t.api}${path}`)).status, path).toBe(401);
      }
    });

    it("rate limits the public sign-in endpoint per client", async () => {
      const limited = await createTestApp({ RATE_LIMIT_ENABLED: "true" });
      try {
        await setDemoSwitches(limited, allDemoOn);
        await seedDemoData(limited);
        const statuses: number[] = [];
        for (let i = 0; i < 14; i++) {
          const res = await request(limited.app.getHttpServer()).post(`${limited.api}/auth/demo/sign-in`).set("Origin", WEB_ORIGIN).set("X-Forwarded-For", "203.0.113.9").send({ role: "customer" });
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
        expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
        // another client is not affected by the first one's budget
        const other = await request(limited.app.getHttpServer()).post(`${limited.api}/auth/demo/sign-in`).set("Origin", WEB_ORIGIN).set("X-Forwarded-For", "203.0.113.77").send({ role: "customer" });
        expect(other.status).toBe(200);
      } finally {
        await limited.close();
      }
    });

    it("limits how fast a demo session may change shared data", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "customer");
      const codes: number[] = [];
      for (let i = 0; i < 62; i++) codes.push((await s.agent.post(`${t.api}/notifications/read-all`).send({})).status);
      expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
      expect(codes.slice(60)).toEqual([429, 429]);
      expect((await s.agent.post(`${t.api}/notifications/read-all`).send({})).body.code).toBe("DEMO_RATE_LIMITED");
      expect((await s.agent.get(`${t.api}/me`)).status).toBe(200); // reading is never limited
    });
  });

  describe("a demo session cannot change its own account or gain credentials", () => {
    const refusedPaths = [
      ["/auth/change-password", { currentPassword: "x", newPassword: "another-long-password-1" }],
      ["/auth/change-email", { newEmail: "someone@example.com" }],
      ["/auth/update-user", { name: "Hacker" }],
      ["/auth/delete-user", {}],
      ["/auth/link-social", { provider: "google" }],
      ["/auth/revoke-other-sessions", {}],
      ["/auth/revoke-sessions", {}],
      ["/auth/revoke-session", { token: "x" }],
    ] as const;

    it("refuses credential, profile, provider and session-management routes", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "customer");
      for (const [path, body] of refusedPaths) {
        const res = await s.agent.post(`${t.api}${path}`).send(body);
        expect(res.status, path).toBe(403);
        expect(res.body.code, path).toBe("DEMO_RESTRICTED");
      }
      // listing sessions would reveal the other visitors' tokens (the identity is shared)
      expect((await s.agent.get(`${t.api}/auth/list-sessions`)).status).toBe(403);
      // reading the session and logging out stay possible
      expect((await s.agent.get(`${t.api}/auth/get-session`)).status).toBe(200);
      expect((await s.agent.post(`${t.api}/auth/sign-out`).send({})).status).toBe(200);
    });

    it("the account is still a demo account afterwards: no password, same email, same role", async () => {
      await setDemoSwitches(t, allDemoOn);
      const s = await demoSession(t, "customer");
      for (const [path, body] of refusedPaths) await s.agent.post(`${t.api}${path}`).send(body);
      const user = await t.prisma.unscoped.user.findUniqueOrThrow({ where: { email: DEMO_PROFILES.customer.email }, include: { accounts: true } });
      expect(user).toMatchObject({ isDemo: true, demoRole: "CUSTOMER", role: "USER", name: "Demo Customer" });
      expect(user.accounts).toHaveLength(0);
    });

    it("no credential flow works for a demo address: sign-in, sign-up, reset and code requests", async () => {
      await setDemoSwitches(t, allDemoOn);
      const email = DEMO_PROFILES.admin.email;
      const signIn = await t.client().post(`${t.api}/auth/sign-in/email`).send({ email, password: "correct-horse-battery" });
      expect(signIn.status).toBe(403);
      expect(signIn.body.code).toBe("DEMO_ACCOUNT");
      expect((await t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "Eve", email, password: "correct-horse-battery" })).status).toBe(403);
      t.mail.outbox.length = 0;
      expect((await t.client().post(`${t.api}/auth/request-password-reset`).send({ email, redirectTo: `${WEB_ORIGIN}/reset-password` })).status).toBe(200);
      expect((await t.client().post(`${t.api}/auth/email-otp/send-verification-otp`).send({ email, type: "email-verification" })).status).toBe(200);
      expect(t.mail.outbox).toHaveLength(0); // nothing was sent to the demo address
      expect((await t.client().post(`${t.api}/auth/email-otp/verify-email`).send({ email, otp: "123456", password: "x" })).status).toBe(403);
      expect(await t.prisma.unscoped.account.count({ where: { user: { isDemo: true } } })).toBe(0);
    });
  });
});
