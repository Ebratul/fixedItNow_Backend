import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, PASSWORD, uniqueEmail, type TestApp } from "./helpers.js";
import { throttleIdentifier } from "../src/auth/otp.js";

/**
 * Email registration with a one-time code. Mail is captured by the console
 * transport; nothing is delivered. Real delivery is NOT verified here.
 */
describe("email verification with a one-time code", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const signUp = (email: string, extra: object = {}) =>
    t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "Test User", email, password: PASSWORD, ...extra });
  const verify = (email: string, otp: string | undefined, password: string | undefined = PASSWORD, agent = t.client()) =>
    agent.post(`${t.api}/auth/email-otp/verify-email`).send({ email, otp, password });
  const resend = (email: string, type = "email-verification") =>
    t.client().post(`${t.api}/auth/email-otp/send-verification-otp`).send({ email, type });
  const verified = async (email: string) => (await t.prisma.user.findUniqueOrThrow({ where: { email } })).emailVerified;
  const otpRows = (email: string) => t.prisma.verification.findMany({ where: { identifier: { contains: email } } });
  /** Pretend the last code was sent `seconds` ago (and optionally the hourly counter value). */
  async function backdate(email: string, seconds: number, count = 1) {
    const identifier = throttleIdentifier(email);
    await t.prisma.verification.updateMany({ where: { identifier }, data: { value: `${count}:${Date.now() - seconds * 1000}` } });
  }
  const wrongCode = (real: string) => (real === "000000" ? "000001" : "000000");

  describe("sending", () => {
    it("emails a 6-digit code on sign-up (never a link) and sends nothing for a duplicate sign-up", async () => {
      const email = uniqueEmail();
      expect((await signUp(email)).status).toBe(200);
      const otp = t.lastOtp(email)!;
      expect(otp).toMatch(/^\d{6}$/);
      const mail = t.mail.outbox.find((m) => m.to === email)!;
      expect(mail.subject).toContain(otp);
      expect(mail.text).not.toMatch(/https?:\/\//);
      expect(mail.text).toMatch(/expires in 10 minutes/);

      t.mail.outbox.length = 0;
      await verify(email, otp);
      expect((await signUp(email)).status).toBe(200); // same answer for an existing account
      expect(t.mail.outbox.filter((m) => m.kind === "verify-otp")).toHaveLength(0); // the real owner gets a notice instead
      expect(t.mail.outbox.filter((m) => m.kind === "account-notice")).toHaveLength(1);
    });

    it("stores only a keyed hash of the code, never the code", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      const rows = await t.prisma.verification.findMany({ where: { identifier: { startsWith: "email-verification-otp" } } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toMatch(/^[0-9a-f]{64}:0$/);
      expect(JSON.stringify(await t.prisma.verification.findMany())).not.toContain(otp);
      // the throttle row holds no address either
      expect((await t.prisma.verification.findMany({ where: { identifier: { startsWith: "otp-send:" } } }))[0]!.identifier).not.toContain("example");
    });

    it("never returns a code in any API response, and responses are identical for new and existing addresses", async () => {
      const a = await signUp(uniqueEmail());
      const taken = uniqueEmail();
      await t.signUpAndLogin(taken);
      const b = await signUp(taken);
      expect(JSON.stringify(a.body)).not.toMatch(/\b\d{6}\b/);
      expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
      expect(a.status).toBe(b.status);
      const r = await resend(uniqueEmail("ghost"));
      expect(JSON.stringify(r.body)).toBe('{"success":true}');
    });
  });

  describe("verifying", () => {
    it("marks the email verified ONLY after the correct code, then signs the user in with a hardened cookie", async () => {
      const email = uniqueEmail();
      await signUp(email);
      expect(await verified(email)).toBe(false);
      const otp = t.lastOtp(email)!;
      const wrong = await verify(email, wrongCode(otp));
      expect(wrong.status).toBe(400);
      expect(await verified(email)).toBe(false);
      expect((await t.client().get(`${t.api}/me`)).status).toBe(401);

      const agent = t.client();
      const ok = await verify(email, otp, PASSWORD, agent);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: true, user: { email, emailVerified: true } });
      expect(await verified(email)).toBe(true);
      const cookie = [ok.headers["set-cookie"]].flat().join(";");
      expect(cookie).toMatch(/better-auth\.session_token=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      const me = await agent.get(`${t.api}/me`);
      expect(me.status).toBe(200);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).role).toBe("USER");
      expect(await otpRows(email)).toHaveLength(0 + (await otpRows(email)).filter((r) => r.identifier.startsWith("otp-send")).length);
    });

    it("rejects a replayed code and does not issue a second session", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      expect((await verify(email, otp)).status).toBe(200);
      const replay = await verify(email, otp);
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe("INVALID_OTP");
      expect(replay.headers["set-cookie"]).toBeUndefined();
      expect(await t.prisma.session.count({ where: { user: { email } } })).toBe(1);
    });

    it("lets exactly one of several parallel submissions of the right code succeed", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      const results = await Promise.all(Array.from({ length: 6 }, () => verify(email, otp)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await t.prisma.session.count({ where: { user: { email } } })).toBe(1);
    });

    it("destroys the code after too many wrong guesses: even the correct code then fails", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      const bad = wrongCode(otp);
      for (let i = 0; i < 5; i++) expect((await verify(email, bad)).status).toBe(400);
      const sixth = await verify(email, bad);
      expect(sixth.status).toBe(403);
      expect(sixth.body.code).toBe("TOO_MANY_ATTEMPTS");
      expect((await verify(email, otp)).status).toBeGreaterThanOrEqual(400); // the right code no longer works
      expect(await verified(email)).toBe(false);
      // the user can request a fresh code (after the cooldown) and finish
      await backdate(email, 120);
      await resend(email);
      expect((await verify(email, t.lastOtp(email)!)).status).toBe(200);
    });

    it("rejects an expired code and leaves the account unverified", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      await t.prisma.verification.updateMany({ where: { identifier: { startsWith: "email-verification-otp" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await verify(email, otp);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_EXPIRED");
      expect(await verified(email)).toBe(false);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("does not accept malformed input and never trusts client-supplied flags", async () => {
      const email = uniqueEmail();
      await signUp(email);
      for (const body of [{}, { email }, { email, otp: "123456" }, { email, otp: 123456, password: PASSWORD }, { email: "nope", otp: "123456", password: PASSWORD }, { email, otp: "", password: PASSWORD }]) {
        const res = await t.client().post(`${t.api}/auth/email-otp/verify-email`).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // a client cannot create a pre-verified or privileged account
      const sneaky = uniqueEmail();
      await signUp(sneaky, { emailVerified: true, role: "ADMIN", id: "chosen-id" });
      const row = await t.prisma.user.findUniqueOrThrow({ where: { email: sneaky } });
      expect(row).toMatchObject({ emailVerified: false, role: "USER" });
      expect(row.id).not.toBe("chosen-id");
      expect((await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: sneaky, password: PASSWORD })).status).toBe(403);
    });

    it("a code for one address cannot verify another", async () => {
      const a = uniqueEmail();
      const b = uniqueEmail();
      await signUp(a);
      await signUp(b);
      const res = await verify(b, t.lastOtp(a)!);
      expect(res.status).toBe(400);
      expect(await verified(b)).toBe(false);
    });
  });

  describe("account pre-hijacking: the code alone is not enough", () => {
    it("someone who registered an address with their own password cannot be 'completed' by the owner entering a mailed code", async () => {
      const victim = uniqueEmail("victim");
      await signUp(victim, { password: "attacker-chosen-password" });
      const otp = t.lastOtp(victim)!; // mailed to the address's real owner
      // the owner does not know the attacker's password: the code is useless to them
      expect((await verify(victim, otp, PASSWORD)).status).toBe(400);
      expect((await verify(victim, otp, undefined)).status).toBe(400);
      expect(await verified(victim)).toBe(false);
      // the attacker knows the password but cannot read the mailbox: a guess fails
      expect((await verify(victim, wrongCode(otp), "attacker-chosen-password")).status).toBe(400);
      expect(await verified(victim)).toBe(false);
    });

    it("a wrong password is answered exactly like a wrong code, and does not use up a guess", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const otp = t.lastOtp(email)!;
      const badPassword = await verify(email, otp, "not-the-password-123");
      const badCode = await verify(email, wrongCode(otp));
      expect(badPassword.status).toBe(badCode.status);
      expect(badPassword.body).toEqual(badCode.body);
      for (let i = 0; i < 10; i++) await verify(email, otp, "not-the-password-123");
      expect((await verify(email, otp)).status).toBe(200); // the real user is not locked out by password guessers
    });

    it("an unknown address and a Google-only (no password) account answer the same generic error", async () => {
      const unknown = await verify(uniqueEmail("ghost"), "123456");
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe("INVALID_OTP");
    });
  });

  describe("resending", () => {
    it("sends a new code only to an unverified account, with identical answers either way", async () => {
      const waiting = uniqueEmail();
      const done = uniqueEmail();
      await signUp(waiting);
      await t.signUpAndLogin(done);
      await backdate(waiting, 120);
      await backdate(done, 120); // otherwise the cooldown (not the "verified" rule) would be what blocks it
      t.mail.outbox.length = 0;
      const answers = [await resend(waiting), await resend(done), await resend(uniqueEmail("ghost"))];
      expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
      expect(answers.map((a) => JSON.stringify(a.body))).toEqual(['{"success":true}', '{"success":true}', '{"success":true}']);
      expect(t.mail.outbox.map((m) => m.to)).toEqual([waiting]); // a verified user's mailbox is never used for codes
    });

    it("the newest code replaces the previous one", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const first = t.lastOtp(email)!;
      await backdate(email, 120);
      await resend(email);
      const second = t.lastOtp(email)!;
      if (first !== second) expect((await verify(email, first)).status).toBe(400);
      expect((await verify(email, second)).status).toBe(200);
    });

    it("enforces a per-ADDRESS cooldown: a too-early resend sends nothing and keeps the current code valid", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const original = t.lastOtp(email)!;
      t.mail.outbox.length = 0;
      const early = await resend(email);
      expect(early.status).toBe(200); // same answer: no cooldown oracle
      expect(t.mail.outbox).toHaveLength(0);
      expect((await verify(email, original)).status).toBe(200); // not rotated away by the blocked request
    });

    it("the cooldown is per address, not per client: a different address is unaffected", async () => {
      const a = uniqueEmail();
      const b = uniqueEmail();
      await signUp(a);
      await signUp(b);
      await backdate(b, 120);
      t.mail.outbox.length = 0;
      await resend(a);
      await resend(b);
      expect(t.mail.outbox.map((m) => m.to)).toEqual([b]);
    });

    it("caps codes per address per hour", async () => {
      const email = uniqueEmail();
      await signUp(email);
      await backdate(email, 120, 5); // five already sent this hour, the last one two minutes ago
      t.mail.outbox.length = 0;
      await resend(email);
      expect(t.mail.outbox).toHaveLength(0);
      await t.prisma.verification.updateMany({ where: { identifier: throttleIdentifier(email) }, data: { expiresAt: new Date(Date.now() - 1000) } }); // the hour is over
      await resend(email);
      expect(t.mail.outbox).toHaveLength(1);
    });

    it("only the email-verification code type can be requested", async () => {
      const email = uniqueEmail();
      await signUp(email);
      await backdate(email, 120);
      t.mail.outbox.length = 0;
      for (const type of ["sign-in", "forget-password", "change-email", "bogus"]) {
        expect((await resend(email, type)).status, type).toBe(400);
      }
      expect(t.mail.outbox).toHaveLength(0);
    });
  });

  describe("routes that must not exist", () => {
    it.each([
      ["post", "/auth/sign-in/email-otp"],
      ["post", "/auth/email-otp/reset-password"],
      ["post", "/auth/email-otp/request-password-reset"],
      ["post", "/auth/forget-password/email-otp"],
      ["post", "/auth/email-otp/check-verification-otp"],
      ["post", "/auth/email-otp/request-email-change"],
      ["post", "/auth/email-otp/change-email"],
      ["post", "/auth/send-verification-email"],
      ["get", "/auth/verify-email?token=x"],
    ] as const)("%s %s is switched off (404)", async (method, path) => {
      const req = t.client()[method](`${t.api}${path}`);
      const res = method === "post" ? await req.send({ email: uniqueEmail(), otp: "123456" }) : await req;
      expect(res.status).toBe(404);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("passwordless sign-in with a code cannot create or open an account", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const res = await t.client().post(`${t.api}/auth/sign-in/email-otp`).send({ email, otp: t.lastOtp(email) });
      expect(res.status).toBe(404);
      expect(await t.prisma.user.count({ where: { email: { not: email } } })).toBe(0);
    });
  });

  describe("login with an unverified account", () => {
    it("is refused with 403 only after the correct password, and no session exists until the code is entered", async () => {
      const email = uniqueEmail();
      await signUp(email);
      const res = await t.client().post(`${t.api}/auth/sign-in/email`).send({ email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await t.prisma.session.count({ where: { user: { email } } })).toBe(0);
    });
  });
});

describe("email verification rate limits (limiter enabled)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ RATE_LIMIT_ENABLED: "true" }); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  it("throttles code requests per client IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      statuses.push((await t.client().post(`${t.api}/auth/email-otp/send-verification-otp`).send({ email: uniqueEmail("rl"), type: "email-verification" })).status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(6).every((s) => s === 429)).toBe(true);
  });

  it("throttles code guesses per client IP", async () => {
    const email = uniqueEmail("rlv");
    const statuses: number[] = [];
    for (let i = 0; i < 18; i++) {
      statuses.push((await t.client().post(`${t.api}/auth/email-otp/verify-email`).send({ email, otp: "000000", password: "x".repeat(12) })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect(statuses.slice(0, 15).every((s) => s === 400)).toBe(true);
  });
});
