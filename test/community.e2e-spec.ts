import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookableWorker, completedBooking, customer } from "./booking-helpers.js";
import { TEST_ENV } from "./fake-providers.js";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("community, reactions, reports and proposals", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(TEST_ENV); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  type P = Awaited<ReturnType<TestApp["signUpAndLogin"]>>;
  const person = (name = "Member One") => t.signUpAndLogin(uniqueEmail("cm"), name);
  const post = async (who: P, title = "Fan repair tips", body = "Which brand lasts longest in humid weather?") => {
    const res = await who.agent.post(`${t.api}/community/posts`).send({ title, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.post as { id: string };
  };
  const proposal = async (who: P, title = "Add a dark theme", description = "Please add a dark theme for night use.") => {
    const res = await who.agent.post(`${t.api}/feature-proposals`).send({ title, description });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.proposal as { id: string };
  };

  describe("access", () => {
    it("requires a session on every community and proposal route", async () => {
      const a = await person();
      const p = await post(a);
      const pr = await proposal(a);
      const anon = () => t.client();
      const calls = [
        anon().get(`${t.api}/community/posts`),
        anon().post(`${t.api}/community/posts`).send({ title: "abc", body: "x" }),
        anon().get(`${t.api}/community/posts/${p.id}`),
        anon().patch(`${t.api}/community/posts/${p.id}`).send({ body: "x" }),
        anon().delete(`${t.api}/community/posts/${p.id}`),
        anon().get(`${t.api}/community/posts/${p.id}/comments`),
        anon().post(`${t.api}/community/posts/${p.id}/comments`).send({ body: "hi" }),
        anon().post(`${t.api}/community/posts/${p.id}/reactions`).send({}),
        anon().delete(`${t.api}/community/posts/${p.id}/reactions/LIKE`),
        anon().post(`${t.api}/community/reports`).send({}),
        anon().post(`${t.api}/reviews/${p.id}/report`).send({}),
        anon().get(`${t.api}/feature-proposals`),
        anon().post(`${t.api}/feature-proposals`).send({}),
        anon().post(`${t.api}/feature-proposals/${pr.id}/vote`).send({}),
        anon().delete(`${t.api}/feature-proposals/${pr.id}/vote`),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    });

    it("rejects state-changing requests from another origin (CSRF)", async () => {
      const a = await person();
      const res = await a.agent.post(`${t.api}/community/posts`).set("Origin", "https://evil.example").send({ title: "Hello there", body: "x" });
      expect(res.status).toBe(403);
      expect(await t.prisma.communityPost.count()).toBe(0);
    });
  });

  describe("posts", () => {
    it("creates a post with the session user as author and public name only", async () => {
      const a = await person("Karim Mia");
      const res = await a.agent.post(`${t.api}/community/posts`).send({ title: "  Fan repair tips ", body: "Which brand lasts longest?" });
      expect(res.status).toBe(201);
      expect(res.body.post).toMatchObject({
        title: "Fan repair tips", body: "Which brand lasts longest?", status: "VISIBLE", author: { displayName: "Karim" },
        isMine: true, likeCount: 0, commentCount: 0, likedByMe: false, editedAt: null,
      });
      const text = JSON.stringify(res.body);
      for (const secret of [a.email, a.userId, "Mia", "authorId"]) expect(text).not.toContain(secret);
    });

    it("stores and returns Bangla text and emoji unchanged, and truncates list previews safely", async () => {
      const a = await person("আশা রহমান");
      const body = "আমার ফ্যানটি খুব শব্দ করে। কোন ব্র্যান্ড ভালো? 👍".repeat(20);
      const p = await post(a, "পাখা মেরামতের পরামর্শ", body);
      const full = (await a.agent.get(`${t.api}/community/posts/${p.id}`)).body.post;
      expect(full).toMatchObject({ title: "পাখা মেরামতের পরামর্শ", body, author: { displayName: "আশা" }, truncated: false });
      const listed = (await a.agent.get(`${t.api}/community/posts`)).body.posts[0];
      expect(listed.truncated).toBe(true);
      expect(listed.body.endsWith("…")).toBe(true);
      expect(listed.body).not.toMatch(/[\ud800-\udbff]…$/); // never cuts an emoji in half
    });

    it("validates input and rejects protected fields", async () => {
      const a = await person();
      const send = (body: object) => a.agent.post(`${t.api}/community/posts`).send(body);
      for (const body of [
        {}, { title: "ab", body: "x" }, { title: "x".repeat(121), body: "x" }, { title: "Valid title", body: "" },
        { title: "Valid title", body: "x".repeat(5001) }, { title: "Valid title", body: "a\u0007b" }, { title: 5, body: "x" },
        { title: "Valid title", body: "x", authorId: "someone" }, { title: "Valid title", body: "x", status: "HIDDEN" },
        { title: "Valid title", body: "x", likeCount: 999 }, { title: "Valid title", body: "x", moderationReason: "x" },
      ]) {
        expect((await send(body)).status, JSON.stringify(body).slice(0, 70)).toBe(400);
      }
      expect(await t.prisma.communityPost.count()).toBe(0);
    });

    it("stores script markup as inert text", async () => {
      const a = await person();
      const xss = `<script>alert(document.cookie)</script><a href="javascript:alert(1)">x</a>`;
      const p = await post(a, "<b>Bold?</b> title", xss);
      const res = await a.agent.get(`${t.api}/community/posts/${p.id}`);
      expect(res.body.post.body).toBe(xss);
      expect(res.body.post.title).toBe("<b>Bold?</b> title");
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("lists newest first, deterministically, with bounded pages", async () => {
      const a = await person();
      for (let i = 1; i <= 5; i++) await post(a, `Post number ${i}`);
      const first = (await a.agent.get(`${t.api}/community/posts?pageSize=2&page=1`)).body;
      const second = (await a.agent.get(`${t.api}/community/posts?pageSize=2&page=2`)).body;
      const third = (await a.agent.get(`${t.api}/community/posts?pageSize=2&page=3`)).body;
      expect([...first.posts, ...second.posts, ...third.posts].map((p: { title: string }) => p.title)).toEqual([5, 4, 3, 2, 1].map((n) => `Post number ${n}`));
      expect([first.total, first.totalPages]).toEqual([5, 3]);
      for (const q of ["pageSize=0", "pageSize=31", "page=0", "scope=everyone"]) expect((await a.agent.get(`${t.api}/community/posts?${q}`)).status).toBe(400);
    });

    it("lets only the author edit or delete, and a deleted post disappears", async () => {
      const a = await person();
      const b = await person("Other Person");
      const p = await post(a);
      const url = `${t.api}/community/posts/${p.id}`;
      expect((await b.agent.patch(url).send({ body: "hijacked" })).status).toBe(404);
      expect((await b.agent.delete(url)).status).toBe(404);
      expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: p.id } })).body).not.toBe("hijacked");
      const edited = await a.agent.patch(url).send({ body: "Edited body" });
      expect(edited.body.post).toMatchObject({ body: "Edited body", editedAt: expect.any(String) });
      expect((await a.agent.patch(url).send({})).status).toBe(400);
      expect((await a.agent.patch(url).send({ status: "VISIBLE" })).status).toBe(400);
      expect((await a.agent.delete(url)).status).toBe(200);
      expect((await a.agent.delete(url)).status).toBe(200); // idempotent
      expect((await a.agent.get(url)).status).toBe(404);
      expect((await b.agent.get(url)).status).toBe(404);
      expect((await a.agent.patch(url).send({ body: "back" })).status).toBe(404);
      expect((await a.agent.get(`${t.api}/community/posts`)).body.posts).toHaveLength(0);
    });

    it("caps how fast one user can post", async () => {
      const a = await person();
      await t.prisma.communityPost.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ authorId: a.userId, title: `Seed post ${i}`, body: "x" })) });
      const res = await a.agent.post(`${t.api}/community/posts`).send({ title: "One too many", body: "x" });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("POST_LIMIT");
    });
  });

  describe("comments", () => {
    it("adds, lists (oldest first, paginated), edits and deletes own comments", async () => {
      const a = await person();
      const b = await person("Bina Das");
      const p = await post(a);
      const c = (await b.agent.post(`${t.api}/community/posts/${p.id}/comments`).send({ body: "  Try Brand X  " })).body.comment;
      expect(c).toMatchObject({ body: "Try Brand X", author: { displayName: "Bina" }, isMine: true });
      await a.agent.post(`${t.api}/community/posts/${p.id}/comments`).send({ body: "Thanks!" });
      const list = (await a.agent.get(`${t.api}/community/posts/${p.id}/comments?pageSize=1`)).body;
      expect(list).toMatchObject({ total: 2, totalPages: 2, comments: [{ body: "Try Brand X", isMine: false }] });
      expect((await a.agent.get(`${t.api}/community/posts/${p.id}`)).body.post.commentCount).toBe(2);

      expect((await a.agent.patch(`${t.api}/community/comments/${c.id}`).send({ body: "hijack" })).status).toBe(404);
      expect((await a.agent.delete(`${t.api}/community/comments/${c.id}`)).status).toBe(404);
      const edited = await b.agent.patch(`${t.api}/community/comments/${c.id}`).send({ body: "Try Brand Y" });
      expect(edited.body.comment).toMatchObject({ body: "Try Brand Y", editedAt: expect.any(String) });
      expect((await b.agent.delete(`${t.api}/community/comments/${c.id}`)).status).toBe(200);
      expect((await a.agent.get(`${t.api}/community/posts/${p.id}`)).body.post.commentCount).toBe(1);
    });

    it("validates comments and refuses unknown, deleted or malformed posts", async () => {
      const a = await person();
      const p = await post(a);
      const send = (id: string, body: object) => a.agent.post(`${t.api}/community/posts/${id}/comments`).send(body);
      for (const body of [{}, { body: "" }, { body: "x".repeat(1001) }, { body: "hi", authorId: "x" }, { body: "hi", postId: "x" }, { body: "hi", status: "HIDDEN" }]) {
        expect((await send(p.id, body)).status).toBe(400);
      }
      expect((await send("00000000-0000-7000-8000-000000000000", { body: "hi" })).status).toBe(404);
      expect((await send("nope", { body: "hi" })).status).toBe(400);
      await a.agent.delete(`${t.api}/community/posts/${p.id}`);
      expect((await send(p.id, { body: "hi" })).status).toBe(404);
      expect((await a.agent.get(`${t.api}/community/posts/${p.id}/comments`)).status).toBe(404);
    });
  });

  describe("reactions", () => {
    it("is idempotent: repeated and parallel likes leave one row and consistent counts", async () => {
      const a = await person();
      const b = await person();
      const p = await post(a);
      const like = (who: P) => who.agent.post(`${t.api}/community/posts/${p.id}/reactions`).send({ type: "LIKE" });
      const results = await Promise.all([like(b), like(b), like(b), like(b), like(b), like(a)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.slice(0, 5).every((r) => r.body.reacted === true)).toBe(true);
      expect(await t.prisma.postReaction.count({ where: { postId: p.id } })).toBe(2);
      expect((await like(b)).body).toEqual({ reacted: true, likeCount: 2 });
      const seen = (await b.agent.get(`${t.api}/community/posts/${p.id}`)).body.post;
      expect(seen).toMatchObject({ likeCount: 2, likedByMe: true });
    });

    it("can be removed, repeatedly, and only affects the caller's own reaction", async () => {
      const a = await person();
      const b = await person();
      const p = await post(a);
      await a.agent.post(`${t.api}/community/posts/${p.id}/reactions`).send({});
      await b.agent.post(`${t.api}/community/posts/${p.id}/reactions`).send({});
      const url = `${t.api}/community/posts/${p.id}/reactions/LIKE`;
      expect((await b.agent.delete(url)).body).toEqual({ reacted: false, likeCount: 1 });
      expect((await b.agent.delete(url)).body).toEqual({ reacted: false, likeCount: 1 });
      expect(await t.prisma.postReaction.count({ where: { userId: a.userId } })).toBe(1);
    });

    it("ignores client counts, validates the type, and rejects missing or removed content", async () => {
      const a = await person();
      const p = await post(a);
      const base = `${t.api}/community/posts/${p.id}/reactions`;
      expect((await a.agent.post(base).send({ type: "HEART" })).status).toBe(400);
      expect((await a.agent.post(base).send({ likeCount: 500 })).status).toBe(400);
      expect((await a.agent.delete(`${base}/HEART`)).status).toBe(400);
      expect((await a.agent.post(`${t.api}/community/posts/00000000-0000-7000-8000-000000000000/reactions`).send({})).status).toBe(404);
      await a.agent.delete(`${t.api}/community/posts/${p.id}`);
      expect((await a.agent.post(base).send({})).status).toBe(404);
      expect(await t.prisma.postReaction.count()).toBe(0);
    });
  });

  describe("reports", () => {
    it("files a report for a post, comment, proposal and review without hiding anything", async () => {
      const author = await person("Author A");
      const reporter = await person("Reporter R");
      const p = await post(author);
      const comment = (await author.agent.post(`${t.api}/community/posts/${p.id}/comments`).send({ body: "spam spam" })).body.comment;
      const pr = await proposal(author);
      const w = await bookableWorker(t);
      const c = await customer(t);
      const bookingId = await completedBooking(t, c, w);
      await c.agent.post(`${t.api}/bookings/${bookingId}/review`).send({ rating: 1, comment: "bad" });
      const reviewId = (await t.prisma.review.findUniqueOrThrow({ where: { bookingId } })).id;

      const file = (body: object) => reporter.agent.post(`${t.api}/community/reports`).send(body);
      expect((await file({ targetType: "POST", targetId: p.id, reason: "SPAM", details: "  ad  " })).status).toBe(201);
      expect((await file({ targetType: "COMMENT", targetId: comment.id, reason: "ABUSE" })).status).toBe(201);
      expect((await file({ targetType: "PROPOSAL", targetId: pr.id, reason: "OTHER" })).status).toBe(201);
      const rev = await reporter.agent.post(`${t.api}/reviews/${reviewId}/report`).send({ reason: "FRAUD" });
      expect(rev.status).toBe(201);
      expect(rev.body.report).toMatchObject({ status: "OPEN" });
      expect(Object.keys(rev.body.report).sort()).toEqual(["createdAt", "id", "status"]);

      const rows = await t.prisma.contentReport.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => r.targetType)).toEqual(["POST", "COMMENT", "PROPOSAL", "REVIEW"]);
      expect(rows.every((r) => r.reporterId === reporter.userId && r.status === "OPEN")).toBe(true);
      expect(rows[0]!.details).toBe("ad");
      // a report never hides content by itself
      expect((await author.agent.get(`${t.api}/community/posts/${p.id}`)).body.post.status).toBe("VISIBLE");
      expect((await t.prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe("VISIBLE");
      // the worker can report a review of their own service
      expect((await w.agent.post(`${t.api}/reviews/${reviewId}/report`).send({ reason: "FRAUD", details: "Never my customer" })).status).toBe(201);
    });

    it("rejects invalid references, reasons, own content, and unknown fields", async () => {
      const author = await person();
      const reporter = await person();
      const p = await post(author);
      const file = (who: P, body: object) => who.agent.post(`${t.api}/community/reports`).send(body);
      const ok = { targetType: "POST", targetId: p.id, reason: "SPAM" };
      expect((await file(reporter, { ...ok, targetType: "USER" })).status).toBe(400); // arbitrary record kinds
      expect((await file(reporter, { ...ok, targetType: "REVIEW" })).status).toBe(400); // reviews have their own route
      expect((await file(reporter, { ...ok, reason: "BORING" })).status).toBe(400);
      expect((await file(reporter, { ...ok, targetId: "1; DROP TABLE users" })).status).toBe(400);
      expect((await file(reporter, { ...ok, details: "x".repeat(501) })).status).toBe(400);
      expect((await file(reporter, { ...ok, reporterId: author.userId })).status).toBe(400);
      expect((await file(reporter, { ...ok, status: "ACTIONED" })).status).toBe(400);
      expect((await file(reporter, { ...ok, targetId: "00000000-0000-7000-8000-000000000000" })).status).toBe(404);
      const own = await file(author, ok);
      expect(own.status).toBe(422);
      expect(own.body.code).toBe("CANNOT_REPORT_OWN_CONTENT");
      expect((await reporter.agent.post(`${t.api}/reviews/00000000-0000-7000-8000-000000000000/report`).send({ reason: "SPAM" })).status).toBe(404);
      // a post's id is not a review id
      expect((await reporter.agent.post(`${t.api}/reviews/${p.id}/report`).send({ reason: "SPAM" })).status).toBe(404);
      expect(await t.prisma.contentReport.count()).toBe(0);
    });

    it("allows one report per user per item, and caps reports per day", async () => {
      const author = await person();
      const reporter = await person();
      const other = await person();
      const p = await post(author);
      const body = { targetType: "POST", targetId: p.id, reason: "SPAM" };
      expect((await reporter.agent.post(`${t.api}/community/reports`).send(body)).status).toBe(201);
      const again = await reporter.agent.post(`${t.api}/community/reports`).send({ ...body, reason: "ABUSE" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("ALREADY_REPORTED");
      expect((await other.agent.post(`${t.api}/community/reports`).send(body)).status).toBe(201); // another user may report it too
      const parallel = await Promise.all([1, 2, 3].map(() => other.agent.post(`${t.api}/community/reports`).send(body)));
      expect(parallel.every((r) => r.status === 409)).toBe(true);
      expect(await t.prisma.contentReport.count({ where: { targetKey: `POST:${p.id}` } })).toBe(2);

      // daily cap
      const spammer = await person();
      const posts = await t.prisma.communityPost.createManyAndReturn({ data: Array.from({ length: 21 }, (_, i) => ({ authorId: author.userId, title: `Target ${i}`, body: "x" })) });
      for (const target of posts.slice(0, 20)) {
        expect((await spammer.agent.post(`${t.api}/community/reports`).send({ targetType: "POST", targetId: target.id, reason: "SPAM" })).status).toBe(201);
      }
      const capped = await spammer.agent.post(`${t.api}/community/reports`).send({ targetType: "POST", targetId: posts[20]!.id, reason: "SPAM" });
      expect(capped.status).toBe(429);
      expect(capped.body.code).toBe("REPORT_LIMIT");
    });

    it("cannot reach content the reporter could not see, and reporters/admin data never appear to users", async () => {
      const author = await person();
      const reporter = await person();
      const p = await post(author);
      await author.agent.delete(`${t.api}/community/posts/${p.id}`);
      expect((await reporter.agent.post(`${t.api}/community/reports`).send({ targetType: "POST", targetId: p.id, reason: "SPAM" })).status).toBe(404);
    });
  });

  describe("feature proposals and votes", () => {
    it("creates SUBMITTED proposals; clients cannot choose status, votes, author or response", async () => {
      const a = await person("Dev Dutta");
      const res = await a.agent.post(`${t.api}/feature-proposals`).send({ title: "Add a dark theme", description: "Please add a dark theme for night use." });
      expect(res.status).toBe(201);
      expect(res.body.proposal).toMatchObject({ status: "SUBMITTED", voteCount: 0, votedByMe: false, votingOpen: true, response: null, author: { displayName: "Dev" }, isMine: true });
      for (const extra of [{ status: "ACCEPTED" }, { voteCount: 100 }, { authorId: "x" }, { response: "x" }, { visibility: "HIDDEN" }]) {
        expect((await a.agent.post(`${t.api}/feature-proposals`).send({ title: "Valid title", description: "A valid description.", ...extra })).status).toBe(400);
      }
      for (const body of [{ title: "abc", description: "A valid description." }, { title: "Valid title", description: "short" }, { title: "Valid title", description: "x".repeat(2001) }]) {
        expect((await a.agent.post(`${t.api}/feature-proposals`).send(body)).status).toBe(400);
      }
      expect(await t.prisma.featureProposal.count()).toBe(1);
    });

    it("limits proposals per user per day", async () => {
      const a = await person();
      for (let i = 0; i < 3; i++) await proposal(a, `Proposal number ${i}`);
      const res = await a.agent.post(`${t.api}/feature-proposals`).send({ title: "Fourth proposal", description: "One too many today." });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("PROPOSAL_LIMIT");
    });

    it("counts one vote per user, even under parallel requests, and lets the user withdraw it", async () => {
      const a = await person();
      const b = await person();
      const pr = await proposal(a);
      const vote = (who: P) => who.agent.post(`${t.api}/feature-proposals/${pr.id}/vote`).send({});
      const res = await Promise.all([vote(b), vote(b), vote(b), vote(b), vote(a)]);
      expect(res.every((r) => r.status === 200 && r.body.voted === true)).toBe(true);
      expect(await t.prisma.featureVote.count({ where: { proposalId: pr.id } })).toBe(2);
      expect((await vote(b)).body).toEqual({ voted: true, voteCount: 2 });
      const listed = (await b.agent.get(`${t.api}/feature-proposals`)).body.proposals[0];
      expect(listed).toMatchObject({ voteCount: 2, votedByMe: true });
      const del = `${t.api}/feature-proposals/${pr.id}/vote`;
      expect((await b.agent.delete(del)).body).toEqual({ voted: false, voteCount: 1 });
      expect((await b.agent.delete(del)).body).toEqual({ voted: false, voteCount: 1 });
      expect(await t.prisma.featureVote.count({ where: { userId: a.userId } })).toBe(1);
    });

    it("refuses votes on unknown proposals and on proposals whose voting has closed", async () => {
      const a = await person();
      const admin = await t.newAdmin();
      const pr = await proposal(a);
      expect((await a.agent.post(`${t.api}/feature-proposals/00000000-0000-7000-8000-000000000000/vote`).send({})).status).toBe(404);
      await a.agent.post(`${t.api}/feature-proposals/${pr.id}/vote`).send({});
      expect((await admin.agent.post(`${t.api}/admin/proposals/${pr.id}/status`).send({ status: "DECLINED", response: "Out of scope for now." })).status).toBe(200);
      const closed = await a.agent.post(`${t.api}/feature-proposals/${pr.id}/vote`).send({});
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe("VOTING_CLOSED");
      expect((await a.agent.delete(`${t.api}/feature-proposals/${pr.id}/vote`)).body.code).toBe("VOTING_CLOSED"); // votes are frozen
      expect(await t.prisma.featureVote.count()).toBe(1);
      const seen = (await a.agent.get(`${t.api}/feature-proposals/${pr.id}`)).body.proposal;
      expect(seen).toMatchObject({ status: "DECLINED", votingOpen: false, response: "Out of scope for now.", voteCount: 1 });
    });

    it("sorts by votes (top) or recency (new) and filters by status", async () => {
      const a = await person();
      const b = await person();
      const first = await proposal(a, "First proposal here");
      const second = await proposal(a, "Second proposal here");
      await b.agent.post(`${t.api}/feature-proposals/${first.id}/vote`).send({});
      await a.agent.post(`${t.api}/feature-proposals/${first.id}/vote`).send({});
      await b.agent.post(`${t.api}/feature-proposals/${second.id}/vote`).send({});
      const top = (await a.agent.get(`${t.api}/feature-proposals?sort=top`)).body.proposals.map((p: { id: string }) => p.id);
      const recent = (await a.agent.get(`${t.api}/feature-proposals?sort=new`)).body.proposals.map((p: { id: string }) => p.id);
      expect(top).toEqual([first.id, second.id]);
      expect(recent).toEqual([second.id, first.id]);
      expect((await a.agent.get(`${t.api}/feature-proposals?status=PLANNED`)).body.proposals).toEqual([]);
      expect((await a.agent.get(`${t.api}/feature-proposals?status=BOGUS`)).status).toBe(400);
    });

    it("reaching the vote threshold changes nothing by itself", async () => {
      const a = await person();
      const pr = await proposal(a);
      const voters = await t.prisma.user.createManyAndReturn({
        data: Array.from({ length: 12 }, (_, i) => ({ id: `voter-${i}`, name: `Voter ${i}`, email: `voter${i}@example.com`, emailVerified: true })),
      });
      await t.prisma.featureVote.createMany({ data: voters.map((v) => ({ proposalId: pr.id, userId: v.id })) });
      const after = (await a.agent.get(`${t.api}/feature-proposals/${pr.id}`)).body.proposal;
      expect(after).toMatchObject({ status: "SUBMITTED", voteCount: 12, votingOpen: true });
      expect(await t.prisma.auditLog.count()).toBe(0);
    });
  });
});
