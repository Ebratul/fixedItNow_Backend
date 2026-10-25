import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, PASSWORD, uniqueEmail, WEB_ORIGIN, type TestApp } from "./helpers.js";

describe("authentication", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const signUp = (email: string, extra: object = {}) =>
    t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "Test User", email, password: PASSWORD, ...extra });
  const signIn = (email: string, password = PASSWORD) =>
    t.client().post(`${t.api}/auth/sign-in/email`).send({ email, password });

  describe("registration", () => {
    it("registers, stores only a hash, and emails a verification CODE (no link)", async () => {
      const email = uniqueEmail();
      const res = await signUp(email);
      expect(res.status).toBe(200);
      expect(res.body.token).toBeNull(); // no session until the email is verified
      expect(res.headers["set-cookie"]).toBeUndefined();

      const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerified).toBe(false);
      expect(user.role).toBe("USER");
      const account = await t.prisma.account.findFirstOrThrow({ where: { userId: user.id } });
      expect(account.password).toBeTruthy();
      expect(account.password).not.toContain(PASSWORD);
      expect(t.lastOtp(email)).toMatch(/^\d{6}$/);
      expect(t.mail.outbox.some((m) => m.to === email && /https?:\/\//.test(m.text))).toBe(false);
    });

    it.each([
      ["a too-short password", { password: "short" }],
      ["an invalid email", { email: "not-an-email" }],
      ["a missing name", { name: undefined }],
      ["an over-long password", { password: "x".repeat(200) }],
    ])("rejects %s", async (_label, override) => {
      const res = await t
        .client()
        .post(`${t.api}/auth/sign-up/email`)
        .send({ name: "T", email: uniqueEmail(), password: PASSWORD, ...override });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("does not reveal whether an email is already registered", async () => {
      const email = uniqueEmail();
      const first = await signUp(email);
      const second = await signUp(email);

      expect(second.status).toBe(first.status);
      expect(Object.keys(second.body).sort()).toEqual(Object.keys(first.body).sort());
      expect(second.body.token).toBeNull();
      expect(await t.prisma.user.count({ where: { email } })).toBe(1);
      // The real owner is told; the requester learns nothing.
      expect(t.mail.outbox.some((m) => m.kind === "account-notice" && m.to === email)).toBe(true);
    });

    it("ignores a client-supplied role", async () => {
      const email = uniqueEmail();
      await signUp(email, { role: "ADMIN", isAdmin: true });
      const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.role).toBe("USER");
    });
  });

  describe("login", () => {
    it("blocks login until the email is verified", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const res = await signIn(email);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("gives wrong-password and unknown-email the same answer", async () => {
      const email = uniqueEmail();
      await t.signUpAndLogin(email);
      const wrong = await signIn(email, "wrong-password-123");
      const unknown = await signIn(uniqueEmail("ghost"), "wrong-password-123");
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it("does not reveal 'unverified' without the correct password", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const res = await signIn(email, "wrong-password-123");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    });

    it("logs a verified user in with a hardened session cookie", async () => {
      const email = uniqueEmail();
      await t.signUpAndLogin(email);
      const res = await signIn(email);
      expect(res.status).toBe(200);
      const cookie = [res.headers["set-cookie"]].flat().join(";");
      expect(cookie).toMatch(/better-auth\.session_token=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });
  });

  describe("sessions", () => {
    it("requires a session for protected routes and rejects invalid cookies", async () => {
      expect((await t.client().get(`${t.api}/me`)).status).toBe(401);
      const bad = await t.client().get(`${t.api}/me`).set("Cookie", "better-auth.session_token=forged.value");
      expect(bad.status).toBe(401);
    });

    it("logout ends the session, and the old cookie cannot be replayed", async () => {
      const { agent, email } = await t.signUpAndLogin(uniqueEmail());
      // Capture the live cookie before logging out.
      const login = await signIn(email);
      const cookie = [login.headers["set-cookie"]].flat().map((c) => c!.split(";")[0]).join("; ");
      expect((await t.client().get(`${t.api}/me`).set("Cookie", cookie)).status).toBe(200);

      expect((await agent.post(`${t.api}/auth/sign-out`).send({})).status).toBe(200);
      expect((await agent.get(`${t.api}/me`)).status).toBe(401);

      // Sign-out only revokes the CURRENT session; other sessions stay valid.
      expect((await t.client().get(`${t.api}/me`).set("Cookie", cookie)).status).toBe(200);
    });

    it("rejects an expired session", async () => {
      const { agent, userId } = await t.signUpAndLogin(uniqueEmail());
      expect((await agent.get(`${t.api}/me`)).status).toBe(200);
      await t.prisma.session.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await agent.get(`${t.api}/me`)).status).toBe(401);
    });
  });

  describe("password reset", () => {
    it("answers identically for known and unknown emails and only emails real users", async () => {
      const email = uniqueEmail();
      await t.signUpAndLogin(email);
      t.mail.outbox.length = 0;
      const known = await t.client().post(`${t.api}/auth/request-password-reset`).send({ email, redirectTo: "/reset-password" });
      const unknown = await t
        .client()
        .post(`${t.api}/auth/request-password-reset`)
        .send({ email: uniqueEmail("ghost"), redirectTo: "/reset-password" });
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
      expect(t.mail.outbox.filter((m) => m.kind === "reset-password")).toHaveLength(1);
    });

    it("resets the password, revokes existing sessions, and the token works once", async () => {
      const email = uniqueEmail();
      const { agent } = await t.signUpAndLogin(email);
      await t.client().post(`${t.api}/auth/request-password-reset`).send({ email, redirectTo: "/reset-password" });
      const link = t.lastLink("reset-password", email)!;

      // Better Auth validates the token, then redirects to our page with ?token=
      const redirect = await t.client().get(link);
      expect(redirect.status).toBe(302);
      const token = new URL(redirect.headers.location, WEB_ORIGIN).searchParams.get("token")!;
      expect(token).toBeTruthy();

      const newPassword = "an-entirely-new-passphrase";
      const reset = await t.client().post(`${t.api}/auth/reset-password`).send({ newPassword, token });
      expect(reset.status).toBe(200);

      expect((await signIn(email, PASSWORD)).status).toBe(401);
      expect((await signIn(email, newPassword)).status).toBe(200);
      expect((await agent.get(`${t.api}/me`)).status).toBe(401); // old session revoked

      const reuse = await t.client().post(`${t.api}/auth/reset-password`).send({ newPassword: "yet-another-passphrase-1", token });
      expect(reuse.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects an invalid reset token", async () => {
      const res = await t.client().post(`${t.api}/auth/reset-password`).send({ newPassword: "an-entirely-new-passphrase", token: "bogus" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("request forgery and redirects", () => {
    it("rejects auth requests from a foreign origin", async () => {
      const res = await t
        .client()
        .post(`${t.api}/auth/sign-in/email`)
        .set("Origin", "https://evil.example")
        .send({ email: uniqueEmail(), password: PASSWORD });
      expect(res.status).toBe(403);
    });

    it.each(["https://evil.example/steal", "//evil.example", "/\\evil.example"])(
      "refuses the open-redirect callbackURL %s",
      async (callbackURL) => {
        const res = await signUp(uniqueEmail(), { callbackURL });
        expect(res.status).toBe(403);
      },
    );

    it("refuses a password-reset redirectTo on a foreign origin", async () => {
      const email = uniqueEmail();
      await t.signUpAndLogin(email);
      const res = await t
        .client()
        .post(`${t.api}/auth/request-password-reset`)
        .send({ email, redirectTo: "https://evil.example/reset" });
      expect(res.status).toBe(403);
    });

    it("accepts a same-site relative callbackURL", async () => {
      const res = await signUp(uniqueEmail(), { callbackURL: "/verify-email" });
      expect(res.status).toBe(200);
    });
  });

  describe("rate limiting", () => {
    it("throttles repeated sign-in attempts", async () => {
      const limited = await createTestApp({ RATE_LIMIT_ENABLED: "true" });
      try {
        const attempt = () =>
          limited.client().post(`${limited.api}/auth/sign-in/email`).send({ email: "someone@example.com", password: "wrong-password-123" });
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) statuses.push((await attempt()).status);
        expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
        expect(statuses).toContain(429);
      } finally {
        await limited.close();
      }
    });
  });

  describe("rate limiting behind a proxy", () => {
    it("cannot be bypassed by rotating a client-supplied X-Forwarded-For", async () => {
      const limited = await createTestApp({ RATE_LIMIT_ENABLED: "true", TRUSTED_PROXIES: "127.0.0.1" });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 9; i++) {
          // Leftmost value is attacker-controlled; the rightmost untrusted hop is the real client.
          const res = await limited
            .client()
            .post(`${limited.api}/auth/sign-in/email`)
            .set("X-Forwarded-For", `10.1.${i}.${i + 1}, 203.0.113.9`)
            .send({ email: "someone@example.com", password: "wrong-password-123" });
          statuses.push(res.status);
        }
        expect(statuses).toContain(429);
      } finally {
        await limited.close();
      }
    });
  });

  describe("production cookie configuration", () => {
    it("marks the session cookie Secure when running in production", async () => {
      const prod = await createTestApp({
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://app.example.test",
        FRONTEND_ORIGIN: "https://app.example.test",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1", // nothing listens here; delivery failures are logged, not thrown
        TRUSTED_PROXIES: "127.0.0.1",
        RATE_LIMIT_ENABLED: "true",
      });
      try {
        const origin = "https://app.example.test";
        const email = uniqueEmail();
        const agent = prod.client().set("Origin", origin);
        await agent.post(`${prod.api}/auth/sign-up/email`).send({ name: "Prod User", email, password: PASSWORD });
        await prod.prisma.user.update({ where: { email }, data: { emailVerified: true } });
        const res = await prod.client().set("Origin", origin).post(`${prod.api}/auth/sign-in/email`).send({ email, password: PASSWORD });
        expect(res.status).toBe(200);
        const cookie = [res.headers["set-cookie"]].flat().join(";");
        expect(cookie).toMatch(/Secure/i);
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/__Secure-better-auth\.session_token|better-auth\.session_token/);
      } finally {
        await prod.close();
      }
    });
  });
});
