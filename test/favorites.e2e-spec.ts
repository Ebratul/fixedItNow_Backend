import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("favorites", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const fav = (agent: any, id: string) => agent.put(`${t.api}/me/favorites/${id}`).send({});
  const unfav = (agent: any, id: string) => agent.delete(`${t.api}/me/favorites/${id}`).send({});

  it("requires authentication for every favorites operation", async () => {
    const w = await t.createWorker();
    const anon = t.client();
    expect((await anon.get(`${t.api}/me/favorites`)).status).toBe(401);
    expect((await anon.get(`${t.api}/me/favorites/ids`)).status).toBe(401);
    expect((await fav(anon, w.profileId)).status).toBe(401);
    expect((await unfav(anon, w.profileId)).status).toBe(401);
    expect(await t.prisma.favorite.count()).toBe(0);
  });

  it("adds, lists, and removes a favorite, identified by the session user", async () => {
    const w = await t.createWorker({ displayName: "Fav Worker" });
    const me = await t.signUpAndLogin(uniqueEmail("c"));

    expect((await fav(me.agent, w.profileId)).body).toEqual({ favorited: true });
    expect((await me.agent.get(`${t.api}/me/favorites/ids`)).body.ids).toEqual([w.profileId]);
    const list = await me.agent.get(`${t.api}/me/favorites`);
    expect(list.body).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect(list.body.workers[0]).toMatchObject({ id: w.profileId, displayName: "Fav Worker", slug: w.slug });
    expect((await t.prisma.favorite.findFirstOrThrow()).userId).toBe(me.userId);

    expect((await unfav(me.agent, w.profileId)).body).toEqual({ favorited: false });
    expect((await me.agent.get(`${t.api}/me/favorites/ids`)).body.ids).toEqual([]);
  });

  it("is idempotent and cannot create duplicates, even under concurrency", async () => {
    const w = await t.createWorker();
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    const results = await Promise.all(Array.from({ length: 8 }, () => fav(me.agent, w.profileId)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await t.prisma.favorite.count()).toBe(1);
    expect((await unfav(me.agent, w.profileId)).status).toBe(200);
    expect((await unfav(me.agent, w.profileId)).status).toBe(200); // repeat is fine
    expect(await t.prisma.favorite.count()).toBe(0);
  });

  it("keeps each user's favorites private (no IDOR)", async () => {
    const w1 = await t.createWorker({ displayName: "Worker One" });
    const w2 = await t.createWorker({ displayName: "Worker Two" });
    const a = await t.signUpAndLogin(uniqueEmail("a"));
    const b = await t.signUpAndLogin(uniqueEmail("b"));
    await fav(a.agent, w1.profileId);
    await fav(b.agent, w2.profileId);

    const listA = (await a.agent.get(`${t.api}/me/favorites`)).body;
    expect(listA.workers.map((w: any) => w.displayName)).toEqual(["Worker One"]);
    // Smuggling another user's id is ignored: lists are always the caller's.
    const spoof = await a.agent.get(`${t.api}/me/favorites?userId=${b.userId}`);
    expect(spoof.body.workers.map((w: any) => w.displayName)).toEqual(["Worker One"]);
    const spoofIds = await a.agent.get(`${t.api}/me/favorites/ids?userId=${b.userId}`);
    expect(spoofIds.body.ids).toEqual([w1.profileId]);

    // A's DELETE can never remove B's favourite.
    await unfav(a.agent, w2.profileId);
    expect(await t.prisma.favorite.count({ where: { userId: b.userId } })).toBe(1);
    // Adding with a smuggled user id still attributes to the caller.
    await a.agent.put(`${t.api}/me/favorites/${w2.profileId}?userId=${b.userId}`).send({ userId: b.userId });
    expect(await t.prisma.favorite.count({ where: { userId: a.userId, workerProfileId: w2.profileId } })).toBe(1);
  });

  it("rejects ineligible, unknown, malformed and self targets", async () => {
    const admin = await t.newAdmin();
    const draft = await t.createWorker({ stage: "draft" });
    const pending = await t.createWorker({ stage: "submitted" });
    const unlisted = await t.createWorker({ stage: "approved", admin });
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    for (const w of [draft, pending, unlisted]) expect((await fav(me.agent, w.profileId)).status).toBe(404);
    expect((await fav(me.agent, "0192a000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await fav(me.agent, "not-a-uuid")).status).toBe(400);
    expect((await fav(me.agent, "1 OR 1=1")).status).toBe(400);

    const own = await t.createWorker({ admin });
    expect((await fav(own.agent, own.profileId)).status).toBe(400);
    expect(await t.prisma.favorite.count()).toBe(0);
  });

  it("hides favorites whose worker is no longer public, but still lets the user remove them", async () => {
    const admin = await t.newAdmin();
    const w = await t.createWorker({ admin });
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    await fav(me.agent, w.profileId);

    await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "policy" });
    expect((await me.agent.get(`${t.api}/me/favorites`)).body.workers).toEqual([]);
    expect((await me.agent.get(`${t.api}/me/favorites/ids`)).body.ids).toEqual([]);
    expect((await fav(await t.signUpAndLogin(uniqueEmail("d")).then((x) => x.agent), w.profileId)).status).toBe(404);
    expect((await unfav(me.agent, w.profileId)).status).toBe(200);
    expect(await t.prisma.favorite.count()).toBe(0);
  });

  it("survives a fresh session (state is server-side)", async () => {
    const w = await t.createWorker();
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    await fav(me.agent, w.profileId);
    const again = t.client();
    await again.post(`${t.api}/auth/sign-in/email`).send({ email: me.email, password: "correct-horse-battery" });
    expect((await again.get(`${t.api}/me/favorites/ids`)).body.ids).toEqual([w.profileId]);
  });

  it("paginates the list with a bounded page size", async () => {
    const admin = await t.newAdmin();
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    for (let i = 0; i < 5; i++) {
      const w = await t.createWorker({ admin, displayName: `W${i}` });
      await fav(me.agent, w.profileId);
    }
    const p1 = (await me.agent.get(`${t.api}/me/favorites?pageSize=2&page=1`)).body;
    const p3 = (await me.agent.get(`${t.api}/me/favorites?pageSize=2&page=3`)).body;
    expect(p1).toMatchObject({ total: 5, totalPages: 3 });
    expect(p1.workers).toHaveLength(2);
    expect(p3.workers).toHaveLength(1);
    expect((await me.agent.get(`${t.api}/me/favorites?pageSize=500`)).status).toBe(400);
  });

  it("rejects cross-origin writes", async () => {
    const w = await t.createWorker();
    const me = await t.signUpAndLogin(uniqueEmail("c"));
    const res = await me.agent.put(`${t.api}/me/favorites/${w.profileId}`).set("Origin", "https://evil.example").send({});
    expect(res.status).toBe(403);
    expect(await t.prisma.favorite.count()).toBe(0);
  });
});
