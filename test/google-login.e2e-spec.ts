import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, PASSWORD, uniqueEmail, type TestApp } from "./helpers.js";

/**
 * Google sign-in, end to end through OUR callback, with Google's HTTP endpoints
 * replaced by a stub (`fetch` is intercepted for accounts.google.com / googleapis.com only).
 * This exercises Better Auth's real state check, PKCE verifier, token exchange handling,
 * ID-token claim handling and account-linking policy. It does NOT prove that real Google
 * accepts our client id / secret / redirect URI: that needs real credentials and a manual run.
 */
const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) =>
  `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;

describe("Google sign-in (stubbed Google)", () => {
  let t: TestApp;
  let tokenCalls: { body: string }[];
  let nextClaims: Record<string, unknown>;
  let tokenStatus = 200;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    t = await createTestApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "fake-client-secret" });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetData();
    tokenCalls = [];
    tokenStatus = 200;
    nextClaims = { sub: "google-sub-1", email: uniqueEmail("g"), email_verified: true, name: "Gina Google", picture: "https://lh3.googleusercontent.com/a/x" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/oauth2\.googleapis\.com\/token/.test(url)) {
        tokenCalls.push({ body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "" });
        if (tokenStatus !== 200) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: tokenStatus, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ access_token: "at-1", token_type: "Bearer", expires_in: 3600, id_token: idToken(nextClaims) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/googleapis\.com|accounts\.google\.com/.test(url)) return new Response(JSON.stringify({}), { status: 404 });
      return realFetch(input, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** Starts the flow like the browser would; returns the agent (it holds the state cookie) and the state. */
  async function begin(callbackURL = "/onboarding") {
    const agent = t.client();
    const res = await agent.post(`${t.api}/auth/sign-in/social`).send({ provider: "google", callbackURL });
    return { agent, state: new URL(res.body.url).searchParams.get("state")!, url: new URL(res.body.url) };
  }
  const callback = (agent: ReturnType<TestApp["client"]>, state: string, extra = "") =>
    agent.get(`${t.api}/auth/callback/google?code=auth-code-1&state=${encodeURIComponent(state)}${extra}`);

  it("signs a new Google user in: verified email, role USER, a hardened session, redirect to the requested page", async () => {
    const { agent, state } = await begin("/onboarding");
    const res = await callback(agent, state);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location!, "http://x").pathname).toBe("/onboarding");
    const cookie = [res.headers["set-cookie"]].flat().join(";");
    expect(cookie).toMatch(/better-auth\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: String(nextClaims.email).toLowerCase() } });
    expect(user).toMatchObject({ emailVerified: true, role: "USER" });
    expect(await t.prisma.account.count({ where: { userId: user.id, providerId: "google", accountId: "google-sub-1" } })).toBe(1);
    expect((await agent.get(`${t.api}/me`)).body.user.email).toBe(user.email);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body).toMatch(/code_verifier=/); // PKCE verifier sent to the token endpoint
  });

  it("a client cannot influence role, verification or identity through the callback", async () => {
    const { agent, state } = await begin();
    const res = await callback(agent, state, "&role=ADMIN&emailVerified=false&userId=attacker&email=other@example.com");
    expect(res.status).toBe(302);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: String(nextClaims.email).toLowerCase() } });
    expect(user.role).toBe("USER");
    expect(user.emailVerified).toBe(true);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it("does not sign in when the state is missing, forged, or belongs to another browser", async () => {
    const a = await begin();
    const b = await begin();
    for (const [agent, state] of [[a.agent, "forged-state-value"], [a.agent, b.state], [t.client(), a.state]] as const) {
      const res = await callback(agent, state);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=/);
      expect([res.headers["set-cookie"]].flat().join(";")).not.toMatch(/session_token=[^;]+/);
    }
    expect(tokenCalls).toHaveLength(0); // never even reached Google's token endpoint
    expect(await t.prisma.user.count()).toBe(0);
  });

  it("a state value works only once (replay)", async () => {
    const { agent, state } = await begin();
    expect((await callback(agent, state)).headers.location).not.toMatch(/error=/);
    const replay = await callback(agent, state);
    expect(replay.headers.location).toMatch(/error=/);
    expect(await t.prisma.session.count()).toBe(1);
  });

  it("handles consent denied, a failed code exchange, and a missing code without creating anything", async () => {
    const denied = await begin();
    const d = await denied.agent.get(`${t.api}/auth/callback/google?error=access_denied&state=${denied.state}`);
    expect(d.headers.location).toMatch(/error=access_denied/);
    const exchange = await begin();
    tokenStatus = 400;
    const e = await callback(exchange.agent, exchange.state);
    expect(e.headers.location).toMatch(/error=/);
    const missing = await begin();
    const m = await missing.agent.get(`${t.api}/auth/callback/google?state=${missing.state}`);
    expect(m.headers.location).toMatch(/error=/);
    expect(await t.prisma.user.count()).toBe(0);
    expect(await t.prisma.session.count()).toBe(0);
  });

  it("refuses a Google account whose email Google reports as unverified", async () => {
    nextClaims = { ...nextClaims, email_verified: false };
    const { agent, state } = await begin();
    const res = await callback(agent, state);
    expect([res.headers["set-cookie"]].flat().join(";")).not.toMatch(/session_token=[^;]+/);
    const user = await t.prisma.user.findUnique({ where: { email: String(nextClaims.email).toLowerCase() } });
    expect(user?.emailVerified ?? false).toBe(false);
    expect(await t.prisma.session.count()).toBe(0);
  });

  describe("account linking is never implicit", () => {
    it("a Google login for an email that already has a password account does NOT sign in or merge", async () => {
      const owner = await t.signUpAndLogin(uniqueEmail("owner"));
      nextClaims = { ...nextClaims, email: owner.email, sub: "google-sub-victim" };
      const { agent, state } = await begin();
      const res = await callback(agent, state);
      expect(res.headers.location).toMatch(/error=/);
      expect([res.headers["set-cookie"]].flat().join(";")).not.toMatch(/session_token=[^;]+/);
      expect(await t.prisma.account.count({ where: { providerId: "google" } })).toBe(0);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { email: owner.email } })).role).toBe("USER");
    });

    it("pre-hijacking: an attacker's UNVERIFIED password account for someone's address is never linked to, nor taken over by, that person's Google login", async () => {
      const victim = uniqueEmail("victim");
      await t.client().post(`${t.api}/auth/sign-up/email`).send({ name: "Mallory", email: victim, password: "attacker-chosen-password" });
      nextClaims = { ...nextClaims, email: victim, sub: "google-sub-real-owner" };
      const { agent, state } = await begin();
      const res = await callback(agent, state);
      expect(res.headers.location).toMatch(/error=/);
      expect([res.headers["set-cookie"]].flat().join(";")).not.toMatch(/session_token=[^;]+/);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { email: victim } });
      expect(row.emailVerified).toBe(false); // Google did not "verify" the attacker's account...
      expect(await t.prisma.account.count({ where: { userId: row.id, providerId: "google" } })).toBe(0); // ...and nothing was linked
      // the attacker's password still cannot log in, because the account was never verified
      expect((await t.client().post(`${t.api}/auth/sign-in/email`).send({ email: victim, password: "attacker-chosen-password" })).status).toBe(403);
    });

    it("a signed-in user can explicitly link Google, and unauthenticated link requests are refused", async () => {
      expect((await t.client().post(`${t.api}/auth/link-social`).send({ provider: "google", callbackURL: "/account" })).status).toBe(401);
      const user = await t.signUpAndLogin(uniqueEmail("linker"));
      const res = await user.agent.post(`${t.api}/auth/link-social`).send({ provider: "google", callbackURL: "/account" });
      expect(res.status).toBe(200);
      expect(new URL(res.body.url).origin).toBe("https://accounts.google.com");
    });
  });

  it("starting the flow needs no secrets in the response and uses only identity scopes", async () => {
    const { url } = await begin();
    expect(url.searchParams.get("scope")?.split(/[ +]/).sort()).toEqual(["email", "openid", "profile"]);
    expect(url.href).not.toContain("fake-client-secret");
    expect(PASSWORD).toBeTruthy();
  });
});
