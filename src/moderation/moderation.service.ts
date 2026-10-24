import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict } from "../bookings/domain-errors.js";
import { authorSelect, excerpt, publicName } from "../common/user-text.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ContentStatus, ReportTargetType } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PROPOSAL_TRANSITIONS, REVIEW_VOTE_THRESHOLD, type ProposalStatusName } from "../proposals/proposals.schemas.js";
import { ADMIN_PAGE_SIZE, type ContentType, type ProposalStatusChange, type ReportDecision } from "./moderation.schemas.js";

type Tx = Prisma.TransactionClient;
type Audited = "CommunityPost" | "PostComment" | "Review" | "FeatureProposal";
const AUDIT_TARGET: Record<ContentType, Audited> = {
  POST: "CommunityPost",
  COMMENT: "PostComment",
  REVIEW: "Review",
  PROPOSAL: "FeatureProposal",
};
const MODERATION_ACTIONS = ["content.", "report.", "proposal."];

/** Row access for one content kind, so hide/restore is written once. */
async function loadContent(tx: Tx, type: ContentType, id: string): Promise<{ authorId: string; status: ContentStatus } | null> {
  switch (type) {
    case "POST":
      return tx.communityPost.findUnique({ where: { id }, select: { authorId: true, status: true } });
    case "COMMENT":
      return tx.postComment.findUnique({ where: { id }, select: { authorId: true, status: true } });
    case "REVIEW": {
      const row = await tx.review.findUnique({ where: { id }, select: { customerId: true, status: true } });
      return row ? { authorId: row.customerId, status: row.status } : null;
    }
    case "PROPOSAL": {
      const row = await tx.featureProposal.findUnique({ where: { id }, select: { authorId: true, visibility: true } });
      return row ? { authorId: row.authorId, status: row.visibility } : null;
    }
  }
}

async function writeVisibility(tx: Tx, type: ContentType, id: string, from: ContentStatus, to: "HIDDEN" | "VISIBLE", adminId: string, reason: string) {
  const moderation = { moderatedById: adminId, moderatedAt: new Date(), moderationReason: to === "HIDDEN" ? reason : null };
  let count: number;
  switch (type) {
    case "POST":
      ({ count } = await tx.communityPost.updateMany({ where: { id, status: from }, data: { status: to, ...moderation } }));
      break;
    case "COMMENT":
      ({ count } = await tx.postComment.updateMany({ where: { id, status: from }, data: { status: to, ...moderation } }));
      break;
    case "REVIEW":
      ({ count } = await tx.review.updateMany({ where: { id, status: from }, data: { status: to, ...moderation } }));
      break;
    case "PROPOSAL":
      ({ count } = await tx.featureProposal.updateMany({ where: { id, visibility: from }, data: { visibility: to, ...moderation } }));
      break;
  }
  if (count === 0) throw conflict("STALE_CONTENT", "This content just changed. Refresh and try again.");
}

const reportSelect = {
  id: true,
  targetType: true,
  targetKey: true,
  reason: true,
  details: true,
  status: true,
  decisionNote: true,
  createdAt: true,
  resolvedAt: true,
  reporterId: true,
  reporter: { select: authorSelect },
  reviewedBy: { select: { name: true } },
  post: { select: { id: true, title: true, body: true, status: true, author: { select: authorSelect } } },
  comment: { select: { id: true, body: true, status: true, postId: true, author: { select: authorSelect } } },
  review: {
    select: {
      id: true, rating: true, comment: true, status: true, createdAt: true,
      customer: { select: authorSelect },
      workerProfile: { select: { displayName: true } },
      revisions: { orderBy: { createdAt: "asc" as const }, take: 20, select: { rating: true, comment: true, createdAt: true } },
    },
  },
  proposal: { select: { id: true, title: true, description: true, visibility: true, author: { select: authorSelect } } },
} satisfies Prisma.ContentReportSelect;
type ReportRow = Prisma.ContentReportGetPayload<{ select: typeof reportSelect }>;

/** The reported item as a moderator sees it: real text, public names only (no emails or ids of people). */
function target(r: ReportRow, full: boolean) {
  const cut = (text: string) => (full ? { text, truncated: false } : excerpt(text, 200));
  if (r.post) {
    const body = cut(r.post.body);
    return { type: "POST" as const, id: r.post.id, status: r.post.status, author: publicName(r.post.author), title: r.post.title, text: body.text, truncated: body.truncated };
  }
  if (r.comment) {
    const body = cut(r.comment.body);
    return { type: "COMMENT" as const, id: r.comment.id, status: r.comment.status, author: publicName(r.comment.author), postId: r.comment.postId, text: body.text, truncated: body.truncated };
  }
  if (r.review) {
    const body = cut(r.review.comment ?? "");
    return {
      type: "REVIEW" as const, id: r.review.id, status: r.review.status, author: publicName(r.review.customer),
      rating: r.review.rating, worker: r.review.workerProfile.displayName, text: body.text, truncated: body.truncated,
      ...(full && { revisions: r.review.revisions }),
    };
  }
  const p = r.proposal!;
  const body = cut(p.description);
  return { type: "PROPOSAL" as const, id: p.id, status: p.visibility, author: publicName(p.author), title: p.title, text: body.text, truncated: body.truncated };
}

@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ reads

  /** Counts derived from stored rows; no personal data. */
  async overview() {
    const p = this.prisma;
    const votesPerProposal = await p.featureVote.groupBy({ by: ["proposalId"], _count: { _all: true }, having: { proposalId: { _count: { gte: REVIEW_VOTE_THRESHOLD } } } });
    const [open, reviewing, openPost, openComment, openReview, openProposal, submitted, hiddenPosts, hiddenComments, hiddenReviews, hiddenProposals, reviews, posts] = await Promise.all([
      p.contentReport.count({ where: { status: "OPEN" } }),
      p.contentReport.count({ where: { status: "REVIEWING" } }),
      p.contentReport.count({ where: { status: "OPEN", targetType: "POST" } }),
      p.contentReport.count({ where: { status: "OPEN", targetType: "COMMENT" } }),
      p.contentReport.count({ where: { status: "OPEN", targetType: "REVIEW" } }),
      p.contentReport.count({ where: { status: "OPEN", targetType: "PROPOSAL" } }),
      p.featureProposal.count({ where: { status: "SUBMITTED", visibility: "VISIBLE" } }),
      p.communityPost.count({ where: { status: "HIDDEN" } }),
      p.postComment.count({ where: { status: "HIDDEN" } }),
      p.review.count({ where: { status: "HIDDEN" } }),
      p.featureProposal.count({ where: { visibility: "HIDDEN" } }),
      p.review.count({ where: { status: "VISIBLE" } }),
      p.communityPost.count({ where: { status: "VISIBLE" } }),
    ]);
    const needsReview = votesPerProposal.length
      ? await p.featureProposal.count({ where: { status: "SUBMITTED", visibility: "VISIBLE", id: { in: votesPerProposal.map((v) => v.proposalId) } } })
      : 0;
    return {
      reports: { open, reviewing, openByType: { POST: openPost, COMMENT: openComment, REVIEW: openReview, PROPOSAL: openProposal } },
      proposals: { submitted, needsReview, voteThreshold: REVIEW_VOTE_THRESHOLD },
      hidden: { posts: hiddenPosts, comments: hiddenComments, reviews: hiddenReviews, proposals: hiddenProposals },
      visible: { reviews, posts },
    };
  }

  async listReports(q: { status: "OPEN" | "REVIEWING" | "ACTIONED" | "DISMISSED"; targetType?: ReportTargetType; page: number }) {
    const where: Prisma.ContentReportWhereInput = { status: q.status, ...(q.targetType && { targetType: q.targetType }) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.contentReport.count({ where }),
      this.prisma.contentReport.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (q.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE,
        select: reportSelect,
      }),
    ]);
    const same = await this.prisma.contentReport.groupBy({ by: ["targetKey"], where: { targetKey: { in: rows.map((r) => r.targetKey) } }, _count: { _all: true } });
    const counts = new Map(same.map((s) => [s.targetKey, s._count._all]));
    return {
      reports: rows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        details: r.details,
        createdAt: r.createdAt,
        reportsOnThisItem: counts.get(r.targetKey) ?? 1,
        target: target(r, false),
      })),
      page: q.page,
      pageSize: ADMIN_PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / ADMIN_PAGE_SIZE),
    };
  }

  async getReport(id: string) {
    const r = await this.prisma.contentReport.findUnique({ where: { id }, select: reportSelect });
    if (!r) throw new NotFoundException("Report not found");
    const t = target(r, true);
    const others = await this.prisma.contentReport.findMany({
      where: { targetKey: r.targetKey, NOT: { id: r.id } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      select: { id: true, reason: true, status: true, createdAt: true },
    });
    return {
      report: {
        id: r.id,
        status: r.status,
        reason: r.reason,
        details: r.details,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        decisionNote: r.decisionNote,
        decidedBy: r.reviewedBy?.name ?? null,
        reporter: { displayName: publicName(r.reporter) },
        target: t,
        otherReports: others,
      },
      history: (await this.history({ targetType: AUDIT_TARGET[r.targetType], targetId: t.id, page: 1 })).entries,
    };
  }

  async history(q: { targetType?: string; targetId?: string; page: number }) {
    const where: Prisma.AuditLogWhereInput = {
      OR: MODERATION_ACTIONS.map((prefix) => ({ action: { startsWith: prefix } })),
      ...(q.targetType && { targetType: q.targetType }),
      ...(q.targetId && { targetId: q.targetId }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (q.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE,
        select: { id: true, action: true, targetType: true, targetId: true, metadata: true, createdAt: true, actor: { select: { name: true } } },
      }),
    ]);
    return {
      entries: rows.map((e) => ({ id: e.id, action: e.action, targetType: e.targetType, targetId: e.targetId, metadata: e.metadata, createdAt: e.createdAt, actor: e.actor?.name ?? null })),
      page: q.page,
      pageSize: ADMIN_PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / ADMIN_PAGE_SIZE),
    };
  }

  // ------------------------------------------------------------------ report decisions

  /**
   * Moves a report along OPEN -> REVIEWING -> ACTIONED | DISMISSED (conditional
   * update, so two moderators cannot both decide). The report decision is
   * SEPARATE from content visibility: content changes only when the moderator
   * explicitly sends `contentAction` with RESOLVE. Everything, including the
   * audit row, happens in one transaction: no audit row, no change.
   */
  async decide(admin: AuthContext, reportId: string, input: ReportDecision) {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.contentReport.findUnique({
        where: { id: reportId },
        select: { id: true, status: true, targetType: true, reporterId: true, postId: true, commentId: true, reviewId: true, proposalId: true },
      });
      if (!report) throw new NotFoundException("Report not found");
      if (report.reporterId === admin.userId) throw new ForbiddenException("You cannot moderate a report you filed");

      const contentId = (report.postId ?? report.commentId ?? report.reviewId ?? report.proposalId)!;
      const content = await loadContent(tx, report.targetType, contentId);
      if (content?.authorId === admin.userId) throw new ForbiddenException("You cannot moderate your own content");

      const next = { REVIEW: "REVIEWING", RESOLVE: "ACTIONED", DISMISS: "DISMISSED" }[input.decision] as "REVIEWING" | "ACTIONED" | "DISMISSED";
      const allowedFrom = input.decision === "REVIEW" ? ["OPEN"] : ["OPEN", "REVIEWING"];
      if (!allowedFrom.includes(report.status)) {
        throw conflict("INVALID_TRANSITION", `A report that is ${report.status.toLowerCase()} cannot be moved to ${next.toLowerCase()}`);
      }

      if (input.contentAction) {
        await this.changeVisibility(tx, admin, report.targetType, contentId, input.contentAction === "HIDE", input.note!, report.id);
      }

      const closing = next !== "REVIEWING";
      const { count } = await tx.contentReport.updateMany({
        where: { id: report.id, status: report.status },
        data: {
          status: next,
          reviewedById: admin.userId,
          ...(input.note && { decisionNote: input.note }),
          ...(closing && { resolvedAt: new Date() }),
        },
      });
      if (count === 0) throw conflict("STALE_REPORT", "This report was just handled by someone else");
      await tx.auditLog.create({
        data: {
          actorId: admin.userId,
          action: { REVIEW: "report.review", RESOLVE: "report.resolve", DISMISS: "report.dismiss" }[input.decision]!,
          targetType: "ContentReport",
          targetId: report.id,
          metadata: { from: report.status, to: next, reason: input.note ?? null, contentType: report.targetType, contentId, contentAction: input.contentAction ?? null },
        },
      });
      return { report: { id: report.id, status: next } };
    });
  }

  // ------------------------------------------------------------------ visibility

  async setVisibility(admin: AuthContext, type: ContentType, id: string, hidden: boolean, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const status = await this.changeVisibility(tx, admin, type, id, hidden, reason, null);
      return { content: { type, id, status } };
    });
  }

  /** Hide VISIBLE -> HIDDEN or restore HIDDEN -> VISIBLE. Author-deleted content is final. Audited in the caller's transaction. */
  private async changeVisibility(tx: Tx, admin: AuthContext, type: ContentType, id: string, hidden: boolean, reason: string, reportId: string | null) {
    const content = await loadContent(tx, type, id);
    if (!content) throw new NotFoundException("Content not found");
    if (content.authorId === admin.userId) throw new ForbiddenException("You cannot moderate your own content");
    if (content.status === "DELETED") throw conflict("CONTENT_DELETED", "The author deleted this content; it cannot be changed");
    const to = hidden ? "HIDDEN" : "VISIBLE";
    if (content.status === to) throw conflict("INVALID_TRANSITION", `This content is already ${hidden ? "hidden" : "visible"}`);
    await writeVisibility(tx, type, id, content.status, to, admin.userId, reason);
    await tx.auditLog.create({
      data: {
        actorId: admin.userId,
        action: hidden ? "content.hide" : "content.restore",
        targetType: AUDIT_TARGET[type],
        targetId: id,
        metadata: { reason, reportId, from: content.status, to },
      },
    });
    return to;
  }

  // ------------------------------------------------------------------ proposals

  async listProposals(q: { status?: ProposalStatusName; needsReview?: boolean; page: number }) {
    let ids: string[] | undefined;
    if (q.needsReview) {
      const rows = await this.prisma.featureVote.groupBy({ by: ["proposalId"], _count: { _all: true }, having: { proposalId: { _count: { gte: REVIEW_VOTE_THRESHOLD } } } });
      ids = rows.map((r) => r.proposalId);
    }
    const where: Prisma.FeatureProposalWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.needsReview && { status: "SUBMITTED", visibility: "VISIBLE", id: { in: ids ?? [] } }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.featureProposal.count({ where }),
      this.prisma.featureProposal.findMany({
        where,
        orderBy: [{ votes: { _count: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
        skip: (q.page - 1) * ADMIN_PAGE_SIZE,
        take: ADMIN_PAGE_SIZE,
        select: {
          id: true, title: true, description: true, status: true, visibility: true, responseNote: true, createdAt: true, respondedAt: true,
          author: { select: authorSelect }, _count: { select: { votes: true, reports: { where: { status: { in: ["OPEN", "REVIEWING"] } } } } },
        },
      }),
    ]);
    return {
      proposals: rows.map((r) => ({
        id: r.id, title: r.title, description: r.description, status: r.status, visibility: r.visibility, response: r.responseNote,
        author: { displayName: publicName(r.author) }, createdAt: r.createdAt, respondedAt: r.respondedAt,
        voteCount: r._count.votes, openReports: r._count.reports,
        reachedThreshold: r._count.votes >= REVIEW_VOTE_THRESHOLD,
        allowedNext: PROPOSAL_TRANSITIONS[r.status],
      })),
      voteThreshold: REVIEW_VOTE_THRESHOLD,
      page: q.page,
      pageSize: ADMIN_PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / ADMIN_PAGE_SIZE),
    };
  }

  async setProposalStatus(admin: AuthContext, id: string, input: ProposalStatusChange) {
    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.featureProposal.findUnique({ where: { id }, select: { id: true, status: true, authorId: true } });
      if (!proposal) throw new NotFoundException("Proposal not found");
      if (proposal.authorId === admin.userId) throw new ForbiddenException("You cannot decide your own proposal");
      if (!PROPOSAL_TRANSITIONS[proposal.status].includes(input.status)) {
        throw new ConflictException({ statusCode: 409, error: "Conflict", code: "INVALID_TRANSITION", message: `A ${proposal.status.toLowerCase().replace("_", " ")} proposal cannot move to ${input.status.toLowerCase().replace("_", " ")}` });
      }
      const { count } = await tx.featureProposal.updateMany({
        where: { id, status: proposal.status },
        data: { status: input.status, responseNote: input.response ?? null, respondedById: admin.userId, respondedAt: new Date() },
      });
      if (count === 0) throw conflict("STALE_PROPOSAL", "This proposal was just changed by someone else");
      await tx.auditLog.create({
        data: {
          actorId: admin.userId,
          action: "proposal.status",
          targetType: "FeatureProposal",
          targetId: id,
          metadata: { from: proposal.status, to: input.status, response: input.response ?? null },
        },
      });
      return { proposal: { id, status: input.status } };
    });
  }
}
