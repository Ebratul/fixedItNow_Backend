import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { customer, type Person } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("admin content browsing and moderation permissions", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const post = async (u: Person, title: string, body = "A perfectly normal post about plumbing tips.") =>
    (await u.agent.post(`${t.api}/community/posts`).send({ title, body })).body.post.id as string;

  it("lists posts, comments and proposals with public names only, filters and pagination", async () => {
    const mod = await t.newAdmin("content_moderator");
    const author = await customer(t, "Priya Author");
    const other = await customer(t, "Quinn Other");
    const p1 = await post(author, "Best electricians in Dhaka");
    await post(other, "Looking for a painter");
    await other.agent.post(`${t.api}/community/posts/${p1}/comments`).send({ body: "I recommend Rahim, call 01711-000000" });
    await author.agent.post(`${t.api}/feature-proposals`).send({ title: "Add a dark mode", description: "Please add a dark theme for night use." });

    const posts = await mod.agent.get(`${t.api}/admin/content/posts`);
    expect(posts.status).toBe(200);
    expect(posts.body.total).toBe(2);
    expect(posts.body.items[0]).toMatchObject({ type: "POST", status: "VISIBLE", author: expect.any(String), openReports: 0 });
    expect(JSON.stringify(posts.body)).not.toMatch(/@example\.com|"authorId"|"userId"/);
    expect((await mod.agent.get(`${t.api}/admin/content/posts?q=painter`)).body.total).toBe(1);
    expect((await mod.agent.get(`${t.api}/admin/content/posts?pageSize=1&page=2`)).body.items).toHaveLength(1);
    expect((await mod.agent.get(`${t.api}/admin/content/comments`)).body.items[0]).toMatchObject({ type: "COMMENT", postId: p1 });
    expect((await mod.agent.get(`${t.api}/admin/content/proposals?q=dark`)).body.items[0]).toMatchObject({ type: "PROPOSAL", title: "Add a dark mode", decision: "SUBMITTED" });
    expect((await mod.agent.get(`${t.api}/admin/content/reviews`)).body.total).toBe(0);
  });

  it("shows hidden items and reported items, so moderators can find what needs attention", async () => {
    const mod = await t.newAdmin("content_moderator");
    const author = await customer(t, "Priya Author");
    const reporter = await customer(t, "Rina Reporter");
    const bad = await post(author, "Get rich quick", "Click here to win money fast");
    await post(author, "Normal post", "Nothing wrong here at all.");
    await reporter.agent.post(`${t.api}/community/reports`).send({ targetType: "POST", targetId: bad, reason: "SPAM" });
    expect((await mod.agent.get(`${t.api}/admin/content/posts?reported=true`)).body.items.map((i: { id: string }) => i.id)).toEqual([bad]);
    expect((await mod.agent.get(`${t.api}/admin/content/posts?reported=true`)).body.items[0].openReports).toBe(1);

    const hide = await mod.agent.post(`${t.api}/admin/moderation/posts/${bad}/visibility`).send({ hidden: true, reason: "Advertising" });
    expect(hide.status).toBe(200);
    const hidden = await mod.agent.get(`${t.api}/admin/content/posts?status=HIDDEN`);
    expect(hidden.body.items).toEqual([expect.objectContaining({ id: bad, status: "HIDDEN", moderationReason: "Advertising" })]);
    expect((await mod.agent.get(`${t.api}/admin/content/posts?status=VISIBLE`)).body.total).toBe(1);
  });

  it("validates type and filters, and separates reading from moderating", async () => {
    const reader = await t.newAdminWith(["moderation.read"]);
    const author = await customer(t);
    const id = await post(author, "Something to look at");
    for (const path of ["admin/content/videos", "admin/content/posts?status=GONE", "admin/content/posts?pageSize=500", "admin/content/posts?reported=maybe"]) {
      expect((await reader.agent.get(`${t.api}/${path}`)).status, path).toBe(400);
    }
    expect((await reader.agent.get(`${t.api}/admin/content/posts`)).status).toBe(200);
    expect((await reader.agent.get(`${t.api}/admin/moderation/overview`)).status).toBe(200);
    expect((await reader.agent.post(`${t.api}/admin/moderation/posts/${id}/visibility`).send({ hidden: true, reason: "no rights" })).status).toBe(403);
    expect((await reader.agent.post(`${t.api}/admin/proposals/${id}/status`).send({ status: "ACCEPTED" })).status).toBe(403);
    const manager = await t.newAdminWith(["moderation.read", "moderation.manage"]);
    expect((await manager.agent.post(`${t.api}/admin/moderation/posts/${id}/visibility`).send({ hidden: true, reason: "Off topic" })).status).toBe(200);
    const none = await t.newAdminWith(["users.read"]);
    expect((await none.agent.get(`${t.api}/admin/content/posts`)).status).toBe(403);
    expect(await (await customer(t)).agent.get(`${t.api}/admin/content/posts`)).toMatchObject({ status: 403 });
  });
});
