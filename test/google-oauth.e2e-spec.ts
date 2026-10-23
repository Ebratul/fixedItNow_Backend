import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN, type TestApp } from "./helpers.js";

/**
 * These tests use FAKE Google credentials and never contact Google. They verify
 * our OAuth configuration and failure handling only. A real end-to-end Google
 * login (token exchange, profile creation) is NOT verified here; it needs real
 * credentials from the Google Cloud console.
 */
describe("Google OAuth (configuration and failure handling)", () => {
  describe("when configured", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        GOOGLE_CLIENT_ID: "fake-client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "fake-client-secret",
      });
    });
    afterAll(() => t.close());
    beforeEach(() => t.resetData());

    const start = (body: object = {}) =>
      t.client().post(`${t.api}/auth/sign-in/social`).send({ provider: "google", callbackURL: "/onboarding", ...body });

    it("advertises Google as enabled", async () => {
      const res = await t.client().get(`${t.api}/config/auth`);
      expect(res.body.googleEnabled).toBe(true);
    });

    it("starts the authorization-code flow with state, PKCE and the right redirect URI", async () => {
      const res = await start();
      expect(res.status).toBe(200);
      const url = new URL(res.body.url);
      expect(url.origin).toBe("https://accounts.google.com");
      const p = url.searchParams;
      expect(p.get("response_type")).toBe("code");
      expect(p.get("client_id")).toBe("fake-client-id.apps.googleusercontent.com");
      expect(p.get("redirect_uri")).toBe(`${WEB_ORIGIN}/api/v1/auth/callback/google`);
      expect(p.get("state")?.length).toBeGreaterThan(10);
      expect(p.get("code_challenge")).toBeTruthy();
      expect(p.get("code_challenge_method")).toBe("S256");
      // Identity scopes only.
      const scopes = (p.get("scope") ?? "").split(/[ ,]+/);
      expect(scopes).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
      expect(scopes.every((s) => ["openid", "email", "profile"].some((ok) => s.endsWith(ok)))).toBe(true);
      // The client secret must never appear in the browser-facing URL.
      expect(res.text).not.toContain("fake-client-secret");
    });

    it("refuses an attacker-controlled post-login redirect", async () => {
      expect((await start({ callbackURL: "https://evil.example" })).status).toBe(403);
      expect((await start({ errorCallbackURL: "https://evil.example" })).status).toBe(403);
    });

    it("rejects a callback with an unknown state and creates no session", async () => {
      const res = await t.client().get(`${t.api}/auth/callback/google?code=abc&state=forged-state`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=/);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await t.prisma.session.count()).toBe(0);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it("handles denied consent / provider errors without creating a session", async () => {
      const res = await t.client().get(`${t.api}/auth/callback/google?error=access_denied&state=forged-state`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=/);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("never auto-links Google to an existing account by email alone", async () => {
      // Policy is configuration, asserted here so a change cannot slip by.
      const { createAuth } = await import("../src/auth/auth.factory.js");
      const auth = createAuth(t.env, t.prisma, t.mail);
      const ctx = await auth.$context;
      expect(ctx.options.account?.accountLinking?.disableImplicitLinking).toBe(true);
      expect(ctx.options.account?.accountLinking?.trustedProviders ?? []).toEqual([]);
      expect(ctx.options.account?.accountLinking?.allowDifferentEmails).toBe(false);
    });
  });

  describe("when not configured", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(() => t.close());

    it("reports Google as disabled and refuses to start the flow", async () => {
      expect((await t.client().get(`${t.api}/config/auth`)).body.googleEnabled).toBe(false);
      const res = await t.client().post(`${t.api}/auth/sign-in/social`).send({ provider: "google", callbackURL: "/onboarding" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.url).toBeUndefined();
    });
  });
});
