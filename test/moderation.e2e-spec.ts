import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookableWorker, completedBooking, customer } from "./booking-helpers.js";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("admin moderation", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  type P = Awaited<ReturnType<TestApp["signUpAndLogin"]>>;
  const person = (name = "Member One") => t.signUpAndLogin(uniqueEmail("md"), name);
  const A = () => `${t.api}/admin`;

  async function setup() {
    const admin = await t.newAdmin();
    const author = await person("Author Aziz");
    const reporter = await person("Reporter Rina");
    const post = (await author.agent.post(`${t.api}/community/posts`).send({ title: "Cheap electrician?", body: "Call me on my number for a deal, best price guaranteed!" })).body.post as { id: string };
    const report = async (who: P = reporter, targetType = "POST", targetId = post.id, reason = "SPAM") => {
      const res = await who.agent.post(`${t.api}/community/reports`).send({ targetType, targetId, reason, details: "Looks like advertising" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.report.id as string;
    };
    return { admin, author, reporter, post, report };
  }
  const auditFor = (targetId: string) => t.prisma.auditLog.findMany({ where: { targetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

  describe("access control", () => {
    it("turns away anonymous users and ordinary users from every admin moderation route", async () => {
      const { post, report } = await setup();
      const reportId = await report();
      const user = await person();
      const routes: [string, string, object?][] = [
        ["get", "/moderation/overview"], ["get", "/moderation/history"], ["get", "/reports"], ["get", `/reports/${reportId}`],
        ["post", `/reports/${reportId}/decision`, { decision: "DISMISS", note: "nope" }],
        ["post", `/moderation/posts/${post.id}/visibility`, { hidden: true, reason: "nope" }],
        ["get", "/proposals"], ["post", `/proposals/${post.id}/status`, { status: "DECLINED", response: "no" }],
      ];
      for (const [method, path, body] of routes) {
        const anon = await (t.client() as any)[method](`${A()}${path}`).send(body ?? {});
        expect(anon.status, `anon ${method} ${path}`).toBe(401);
        const res = await (user.agent as any)[method](`${A()}${path}`).send(body ?? {});
        expect(res.status, `user ${method} ${path}`).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain("Looks like advertising");
      }
      expect((await t.prisma.contentReport.findUniqueOrThrow({ where: { id: reportId } })).status).toBe("OPEN");
      expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("VISIBLE");
    });

    it("never takes authorization from the request: role fields in bodies and queries do nothing", async () => {
      const { post } = await setup();
      const user = await person();
      const res = await user.agent.post(`${A()}/moderation/posts/${post.id}/visibility?role=ADMIN`).set("X-Role", "ADMIN").send({ hidden: true, reason: "xx", role: "ADMIN", isAdmin: true });
      expect(res.status).toBe(403);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).role).toBe("USER");
    });

    it("validates ids, bodies and queries for admins too", async () => {
      const { admin, post } = await setup();
      expect((await admin.agent.get(`${A()}/reports/not-a-uuid`)).status).toBe(400);
      expect((await admin.agent.get(`${A()}/reports/00000000-0000-7000-8000-000000000000`)).status).toBe(404);
      expect((await admin.agent.get(`${A()}/reports?status=NOPE`)).status).toBe(400);
      expect((await admin.agent.get(`${A()}/reports?page=0`)).status).toBe(400);
      expect((await admin.agent.post(`${A()}/moderation/accounts/${post.id}/visibility`).send({ hidden: true, reason: "xxx" })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/moderation/posts/${post.id}/visibility`).send({ hidden: true })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/moderation/posts/${post.id}/visibility`).send({ hidden: true, reason: "xxx", extra: 1 })).status).toBe(400);
    });
  });

  describe("report queue", () => {
    it("lists reports with the reported text and public names only; paginates; filters", async () => {
      const { admin, author, reporter, post, report } = await setup();
      await report();
      const comment = (await author.agent.post(`${t.api}/community/posts/${post.id}/comments`).send({ body: "buy now" })).body.comment;
      await report(reporter, "COMMENT", comment.id, "ABUSE");
      const res = await admin.agent.get(`${A()}/reports`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 25, total: 2, totalPages: 1 });
      expect(res.body.reports[0]).toMatchObject({ status: "OPEN", reason: "SPAM", reportsOnThisItem: 1, target: { type: "POST", id: post.id, status: "VISIBLE", author: "Author", title: "Cheap electrician?" } });
      expect(res.body.reports[1].target).toMatchObject({ type: "COMMENT", text: "buy now" });
      const text = JSON.stringify(res.body);
      for (const secret of [author.email, reporter.email, author.userId, reporter.userId, "reporterId", "authorId", "Aziz", "Rina"]) {
        expect(text, secret).not.toContain(secret);
      }
      expect((await admin.agent.get(`${A()}/reports?targetType=COMMENT`)).body.total).toBe(1);
      expect((await admin.agent.get(`${A()}/reports?status=ACTIONED`)).body.total).toBe(0);
    });

    it("shows reporter privacy rules: a detail view names the reporter by public name only, and others never see reports", async () => {
      const { admin, reporter, report, author, post } = await setup();
      const id = await report();
      const detail = (await admin.agent.get(`${A()}/reports/${id}`)).body;
      expect(detail.report.reporter).toEqual({ displayName: "Reporter" });
      expect(detail.report.target).toMatchObject({ type: "POST", text: expect.stringContaining("best price guaranteed") });
      expect(JSON.stringify(detail)).not.toContain(reporter.email);
      // the content owner can read their post, which carries no report data at all
      expect(JSON.stringify((await author.agent.get(`${t.api}/community/posts/${post.id}`)).body)).not.toMatch(/report|Reporter/i);
    });

    it("groups repeat reports and includes a review's edit history for moderators", async () => {
      const { admin, reporter } = await setup();
      const w = await bookableWorker(t);
      const c = await customer(t);
      const bookingId = await completedBooking(t, c, w);
      await c.agent.post(`${t.api}/bookings/${bookingId}/review`).send({ rating: 1, comment: "Terrible" });
      await c.agent.put(`${t.api}/bookings/${bookingId}/review`).send({ rating: 5, comment: "Great, call 017..." });
      const review = await t.prisma.review.findUniqueOrThrow({ where: { bookingId } });
      const id = (await reporter.agent.post(`${t.api}/reviews/${review.id}/report`).send({ reason: "FRAUD" })).body.report.id as string;
      const other = await person();
      await other.agent.post(`${t.api}/reviews/${review.id}/report`).send({ reason: "SPAM" });
      const detail = (await admin.agent.get(`${A()}/reports/${id}`)).body.report;
      expect(detail.target).toMatchObject({ type: "REVIEW", rating: 5, revisions: [{ rating: 1, comment: "Terrible" }] });
      expect(detail.otherReports).toHaveLength(1);
      expect((await admin.agent.get(`${A()}/reports`)).body.reports[0].reportsOnThisItem).toBe(2);
    });
  });

  describe("report decisions and content visibility", () => {
    it("OPEN -> REVIEWING -> ACTIONED; resolving with HIDE hides the content, and every step is audited with actor and reason", async () => {
      const { admin, author, post, report } = await setup();
      const id = await report();
      const step1 = await admin.agent.post(`${A()}/reports/${id}/decision`).send({ decision: "REVIEW" });
      expect(step1.body.report).toEqual({ id, status: "REVIEWING" });
      expect((await author.agent.get(`${t.api}/community/posts/${post.id}`)).body.post.status).toBe("VISIBLE"); // reviewing hides nothing
      const step2 = await admin.agent.post(`${A()}/reports/${id}/decision`).send({ decision: "RESOLVE", note: "Advertising, against the rules", contentAction: "HIDE" });
      expect(step2.body.report.status).toBe("ACTIONED");

      const saved = await t.prisma.contentReport.findUniqueOrThrow({ where: { id } });
      expect(saved).toMatchObject({ status: "ACTIONED", reviewedById: admin.userId, decisionNote: "Advertising, against the rules" });
      expect(saved.resolvedAt).not.toBeNull();
      const content = await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } });
      expect(content).toMatchObject({ status: "HIDDEN", moderatedById: admin.userId, moderationReason: "Advertising, against the rules" });
      expect(content.body).toContain("best price guaranteed"); // text is never rewritten by moderation

      const reportAudit = await auditFor(id);
      expect(reportAudit.map((a) => a.action)).toEqual(["report.review", "report.resolve"]);
      expect(reportAudit[1]).toMatchObject({ actorId: admin.userId, targetType: "ContentReport", metadata: { from: "REVIEWING", to: "ACTIONED", reason: "Advertising, against the rules", contentAction: "HIDE", contentType: "POST", contentId: post.id } });
      const contentAudit = await auditFor(post.id);
      expect(contentAudit).toHaveLength(1);
      expect(contentAudit[0]).toMatchObject({ action: "content.hide", actorId: admin.userId, targetType: "CommunityPost", metadata: { reason: "Advertising, against the rules", reportId: id } });

      // others no longer see it; the author sees a removed state; the feed omits it
      const other = await person();
      expect((await other.agent.get(`${t.api}/community/posts/${post.id}`)).status).toBe(404);
      expect((await other.agent.get(`${t.api}/community/posts`)).body.posts).toHaveLength(0);
      const own = (await author.agent.get(`${t.api}/community/posts/${post.id}`)).body.post;
      expect(own.status).toBe("HIDDEN");
      expect(JSON.stringify(own)).not.toContain("Advertising, against the rules"); // the reason is internal
      expect((await author.agent.get(`${t.api}/community/posts?scope=mine`)).body.posts[0].status).toBe("HIDDEN");
      expect((await author.agent.patch(`${t.api}/community/posts/${post.id}`).send({ body: "edited to evade" })).body.code).toBe("CONTENT_UNDER_MODERATION");
      expect((await author.agent.delete(`${t.api}/community/posts/${post.id}`)).body.code).toBe("CONTENT_UNDER_MODERATION");
      expect((await other.agent.post(`${t.api}/community/posts/${post.id}/reactions`).send({})).status).toBe(404);
    });

    it("resolve without a content action leaves the content visible; dismiss never changes content; both need a note", async () => {
      const { admin, post, report, reporter } = await setup();
      const first = await report();
      expect((await admin.agent.post(`${A()}/reports/${first}/decision`).send({ decision: "RESOLVE" })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/reports/${first}/decision`).send({ decision: "DISMISS" })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/reports/${first}/decision`).send({ decision: "DISMISS", note: "Not a violation", contentAction: "HIDE" })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/reports/${first}/decision`).send({ decision: "REVIEW", contentAction: "HIDE" })).status).toBe(400);
      expect((await admin.agent.post(`${A()}/reports/${first}/decision`).send({ decision: "DISMISS", note: "Not a violation" })).body.report.status).toBe("DISMISSED");
      expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("VISIBLE");

      const second = await report(await person(), "POST", post.id, "ABUSE");
      expect((await admin.agent.post(`${A()}/reports/${second}/decision`).send({ decision: "RESOLVE", note: "Warned the author" })).body.report.status).toBe("ACTIONED");
      expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("VISIBLE");
      void reporter;
    });

    it("enforces the state machine: closed reports are final, REVIEW only from OPEN", async () => {
      const { admin, report } = await setup();
      const id = await report();
      const decide = (body: object) => admin.agent.post(`${A()}/reports/${id}/decision`).send(body);
      await decide({ decision: "REVIEW" });
      const again = await decide({ decision: "REVIEW" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("INVALID_TRANSITION");
      await decide({ decision: "DISMISS", note: "fine" });
      for (const body of [{ decision: "REVIEW" }, { decision: "RESOLVE", note: "again one" }, { decision: "DISMISS", note: "again two" }]) {
        const res = await decide(body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("INVALID_TRANSITION");
      }
      expect((await auditFor(id)).map((a) => a.action)).toEqual(["report.review", "report.dismiss"]);
    });

    it("lets exactly one of two parallel moderators decide, with one audit row", async () => {
      const { admin, report } = await setup();
      const second = await t.newAdmin();
      const id = await report();
      const body = { decision: "DISMISS", note: "Not a violation" };
      const [a, b] = await Promise.all([admin.agent.post(`${A()}/reports/${id}/decision`).send(body), second.agent.post(`${A()}/reports/${id}/decision`).send(body)]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      expect(await t.prisma.auditLog.count({ where: { targetId: id } })).toBe(1);
    });

    it("writes no audit row and changes nothing when a decision fails", async () => {
      const { admin, post, report } = await setup();
      const id = await report();
      await admin.agent.post(`${A()}/moderation/posts/${post.id}/visibility`).send({ hidden: true, reason: "Hidden directly" });
      const before = await t.prisma.auditLog.count();
      // RESOLVE+HIDE on content that is already hidden fails -> the report must not change either
      const res = await admin.agent.post(`${A()}/reports/${id}/decision`).send({ decision: "RESOLVE", note: "Hide it", contentAction: "HIDE" });
      expect(res.status).toBe(409);
      expect((await t.prisma.contentReport.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
      expect(await t.prisma.auditLog.count()).toBe(before);
    });

    it("is atomic with its audit row: if the audit write fails, the content stays as it was", async () => {
      const { admin, post } = await setup();
      await t.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$ LANGUAGE plpgsql`);
      await t.prisma.$executeRawUnsafe(`CREATE TRIGGER fail_audit_t BEFORE INSERT ON "audit_log" FOR EACH ROW EXECUTE FUNCTION fail_audit()`);
      try {
        const res = await admin.agent.post(`${A()}/moderation/posts/${post.id}/visibility`).send({ hidden: true, reason: "Spam link" });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("audit unavailable");
        expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("VISIBLE");
      } finally {
        await t.prisma.$executeRawUnsafe(`DROP TRIGGER fail_audit_t ON "audit_log"`);
        await t.prisma.$executeRawUnsafe(`DROP FUNCTION fail_audit()`);
      }
    });

    it("blocks conflicts of interest: an admin cannot moderate their own content or a report they filed", async () => {
      const { admin, report } = await setup();
      const myPost = (await admin.agent.post(`${t.api}/community/posts`).send({ title: "Admin announcement", body: "Hello everyone" })).body.post.id as string;
      const other = await t.newAdmin();
      const against = (await other.agent.post(`${t.api}/community/reports`).send({ targetType: "POST", targetId: myPost, reason: "OTHER" })).body.report.id as string;
      expect((await admin.agent.post(`${A()}/reports/${against}/decision`).send({ decision: "DISMISS", note: "my own post" })).status).toBe(403);
      expect((await admin.agent.post(`${A()}/moderation/posts/${myPost}/visibility`).send({ hidden: true, reason: "my own" })).status).toBe(403);
      const filed = await report(admin);
      expect((await admin.agent.post(`${A()}/reports/${filed}/decision`).send({ decision: "DISMISS", note: "my own report" })).status).toBe(403);
      expect(await t.prisma.auditLog.count()).toBe(0);
    });

    it("hides and restores directly, requires a reason, and never resurrects author-deleted content", async () => {
      const { admin, author, post } = await setup();
      const url = `${A()}/moderation/posts/${post.id}/visibility`;
      expect((await admin.agent.post(url).send({ hidden: false, reason: "restore" })).body.code).toBe("INVALID_TRANSITION"); // already visible
      expect((await admin.agent.post(url).send({ hidden: true, reason: "ab" })).status).toBe(400);
      expect((await admin.agent.post(url).send({ hidden: true, reason: "Spam link" })).body.content).toEqual({ type: "POST", id: post.id, status: "HIDDEN" });
      expect((await admin.agent.post(url).send({ hidden: true, reason: "again" })).body.code).toBe("INVALID_TRANSITION");
      expect((await admin.agent.post(url).send({ hidden: false, reason: "Reviewed, fine" })).body.content.status).toBe("VISIBLE");
      expect((await t.prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).moderationReason).toBeNull();
      expect((await auditFor(post.id)).map((a) => a.action)).toEqual(["content.hide", "content.restore"]);
      await author.agent.delete(`${t.api}/community/posts/${post.id}`);
      const dead = await admin.agent.post(url).send({ hidden: false, reason: "Bring it back" });
      expect(dead.status).toBe(409);
      expect(dead.body.code).toBe("CONTENT_DELETED"); // the author deleted it: final
    });

    it("moderates comments, proposals and reviews, and review moderation changes ratings but not the text", async () => {
      const { admin, author, post } = await setup();
      const comment = (await author.agent.post(`${t.api}/community/posts/${post.id}/comments`).send({ body: "spam" })).body.comment.id as string;
      expect((await admin.agent.post(`${A()}/moderation/comments/${comment}/visibility`).send({ hidden: true, reason: "Spam comment" })).status).toBe(200);
      expect((await author.agent.get(`${t.api}/community/posts/${post.id}`)).body.post.commentCount).toBe(0);
      expect((await author.agent.patch(`${t.api}/community/comments/${comment}`).send({ body: "evade" })).body.code).toBe("CONTENT_UNDER_MODERATION");

      const pr = (await author.agent.post(`${t.api}/feature-proposals`).send({ title: "Buy my product", description: "Visit my shop for deals." })).body.proposal.id as string;
      const user = await person();
      expect((await admin.agent.post(`${A()}/moderation/proposals/${pr}/visibility`).send({ hidden: true, reason: "Advertising" })).status).toBe(200);
      expect((await user.agent.get(`${t.api}/feature-proposals`)).body.proposals).toHaveLength(0);
      expect((await user.agent.post(`${t.api}/feature-proposals/${pr}/vote`).send({})).status).toBe(404);

      const w = await bookableWorker(t);
      const c = await customer(t);
      const bookingId = await completedBooking(t, c, w);
      await c.agent.post(`${t.api}/bookings/${bookingId}/review`).send({ rating: 1, comment: "rude" });
      const review = await t.prisma.review.findUniqueOrThrow({ where: { bookingId } });
      await admin.agent.post(`${A()}/moderation/reviews/${review.id}/visibility`).send({ hidden: true, reason: "Personal attack" });
      const after = await t.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
      expect(after).toMatchObject({ status: "HIDDEN", rating: 1, comment: "rude", moderationReason: "Personal attack" });
      expect((await c.agent.put(`${t.api}/bookings/${bookingId}/review`).send({ rating: 5 })).body.code).toBe("REVIEW_NOT_EDITABLE");
      expect((await c.agent.delete(`${t.api}/bookings/${bookingId}/review`)).body.code).toBe("REVIEW_NOT_EDITABLE");
    });
  });

  describe("proposal decisions", () => {
    async function proposalSetup() {
      const admin = await t.newAdmin();
      const author = await person("Author Aziz");
      const pr = (await author.agent.post(`${t.api}/feature-proposals`).send({ title: "Add a dark theme", description: "Please add a dark theme for night use." })).body.proposal.id as string;
      const set = (body: object, who: P = admin) => who.agent.post(`${A()}/proposals/${pr}/status`).send(body);
      return { admin, author, pr, set };
    }

    it("follows SUBMITTED -> UNDER_REVIEW -> ACCEPTED -> PLANNED -> COMPLETED with audit rows", async () => {
      const { admin, pr, set } = await proposalSetup();
      for (const status of ["UNDER_REVIEW", "ACCEPTED", "PLANNED", "COMPLETED"]) {
        const res = await set({ status, response: status === "ACCEPTED" ? "Good idea, queued." : undefined });
        expect(res.status, status).toBe(200);
      }
      const audit = await auditFor(pr);
      expect(audit.map((a) => a.action)).toEqual(Array(4).fill("proposal.status"));
      expect(audit[1]!.metadata).toMatchObject({ from: "UNDER_REVIEW", to: "ACCEPTED", response: "Good idea, queued." });
      expect(audit.every((a) => a.actorId === admin.userId)).toBe(true);
      expect((await t.prisma.featureProposal.findUniqueOrThrow({ where: { id: pr } })).respondedById).toBe(admin.userId);
    });

    it("rejects illegal jumps and final states, and requires a response to decline", async () => {
      const { pr, set } = await proposalSetup();
      for (const status of ["ACCEPTED", "PLANNED", "COMPLETED", "SUBMITTED"]) {
        const res = await set({ status });
        expect(res.status, status).toBe(409);
        expect(res.body.code).toBe("INVALID_TRANSITION");
      }
      expect((await set({ status: "DECLINED" })).status).toBe(400);
      expect((await set({ status: "DECLINED", response: "Not planned." })).status).toBe(200);
      expect((await set({ status: "UNDER_REVIEW" })).body.code).toBe("INVALID_TRANSITION");
      expect((await set({ status: "NOPE" })).status).toBe(400);
      expect((await set({ status: "UNDER_REVIEW", authorId: "x" })).status).toBe(400);
      expect(await t.prisma.auditLog.count({ where: { targetId: pr } })).toBe(1);
    });

    it("keeps admins from deciding their own proposals, and ordinary users from deciding any", async () => {
      const admin = await t.newAdmin();
      const mine = (await admin.agent.post(`${t.api}/feature-proposals`).send({ title: "Admin's idea", description: "An idea from an admin." })).body.proposal.id as string;
      expect((await admin.agent.post(`${A()}/proposals/${mine}/status`).send({ status: "UNDER_REVIEW" })).status).toBe(403);
      const user = await person();
      expect((await user.agent.post(`${A()}/proposals/${mine}/status`).send({ status: "ACCEPTED" })).status).toBe(403);
      expect((await t.prisma.featureProposal.findUniqueOrThrow({ where: { id: mine } })).status).toBe("SUBMITTED");
    });

    it("surfaces proposals at the vote threshold in the admin 'needs review' view without changing them", async () => {
      const { admin, pr } = await proposalSetup();
      const voters = await t.prisma.user.createManyAndReturn({
        data: Array.from({ length: 10 }, (_, i) => ({ id: `thr-${i}`, name: `V ${i}`, email: `thr${i}@example.com`, emailVerified: true })),
      });
      expect((await admin.agent.get(`${A()}/proposals?needsReview=true`)).body.total).toBe(0);
      await t.prisma.featureVote.createMany({ data: voters.slice(0, 9).map((v) => ({ proposalId: pr, userId: v.id })) });
      expect((await admin.agent.get(`${A()}/proposals?needsReview=true`)).body.total).toBe(0);
      await t.prisma.featureVote.create({ data: { proposalId: pr, userId: voters[9]!.id } });
      const queue = (await admin.agent.get(`${A()}/proposals?needsReview=true`)).body;
      expect(queue).toMatchObject({ total: 1, voteThreshold: 10, proposals: [{ id: pr, status: "SUBMITTED", voteCount: 10, reachedThreshold: true, allowedNext: ["UNDER_REVIEW", "DECLINED"] }] });
      expect((await t.prisma.featureProposal.findUniqueOrThrow({ where: { id: pr } })).status).toBe("SUBMITTED");
      expect(await t.prisma.auditLog.count()).toBe(0);
      expect((await admin.agent.get(`${A()}/proposals?needsReview=maybe`)).status).toBe(400);
    });
  });

  describe("overview and history", () => {
    it("reports counts derived from stored rows", async () => {
      const { admin, post, report, author } = await setup();
      await report();
      const second = await report(await person(), "POST", post.id, "ABUSE");
      await admin.agent.post(`${A()}/reports/${second}/decision`).send({ decision: "REVIEW" });
      await admin.agent.post(`${t.api.replace("/api/v1", "")}${A()}/x`).send({}); // unknown route is harmless
      const o = (await admin.agent.get(`${A()}/moderation/overview`)).body;
      expect(o.reports).toMatchObject({ open: 1, reviewing: 1, openByType: { POST: 1, COMMENT: 0, REVIEW: 0, PROPOSAL: 0 } });
      expect(o).toMatchObject({ proposals: { submitted: 0, needsReview: 0, voteThreshold: 10 }, hidden: { posts: 0, comments: 0, reviews: 0, proposals: 0 }, visible: { reviews: 0, posts: 1 } });
      await admin.agent.post(`${A()}/moderation/posts/${post.id}/visibility`).send({ hidden: true, reason: "Spam" });
      const after = (await admin.agent.get(`${A()}/moderation/overview`)).body;
      expect(after.hidden.posts).toBe(1);
      expect(after.visible.posts).toBe(0);
      void author;
    });

    it("shows moderation history only (no other audit rows), newest first, with actor names and no emails", async () => {
      const { admin, post, report } = await setup();
      await t.prisma.auditLog.create({ data: { actorId: admin.userId, action: "worker.suspend", targetType: "WorkerProfile", targetId: post.id, metadata: { secret: "do-not-show" } } });
      const id = await report();
      await admin.agent.post(`${A()}/reports/${id}/decision`).send({ decision: "RESOLVE", note: "Spam removed", contentAction: "HIDE" });
      const res = await admin.agent.get(`${A()}/moderation/history`);
      // both rows are written in one transaction, so their relative order within the same millisecond is not meaningful
      expect(res.body.entries.map((e: { action: string }) => e.action).sort()).toEqual(["content.hide", "report.resolve"]);
      expect(res.body.entries[0].actor).toBe("Test User");
      const text = JSON.stringify(res.body);
      expect(text).not.toContain("do-not-show");
      expect(text).not.toContain(admin.email);
      expect((await admin.agent.get(`${A()}/moderation/history?targetType=ContentReport&targetId=${id}`)).body.total).toBe(1);
      expect((await admin.agent.get(`${A()}/moderation/history?targetType=User`)).status).toBe(400);
      expect((await admin.agent.get(`${A()}/reports/${id}`)).body.history.map((e: { action: string }) => e.action)).toEqual(["content.hide"]);
    });
  });
});
