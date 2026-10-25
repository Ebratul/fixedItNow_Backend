import { Injectable } from "@nestjs/common";
import { authorSelect, excerpt, publicName } from "../../common/user-text.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { ContentStatus } from "../../generated/prisma/enums.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import type { ContentType } from "../../moderation/moderation.schemas.js";

export type ContentQuery = { type: ContentType; status?: ContentStatus; q?: string; reported?: boolean; page: number; pageSize: number };

const OPEN_REPORT = { status: { in: ["OPEN", "REVIEWING"] as ("OPEN" | "REVIEWING")[] } };

/**
 * Browse community content by kind so moderators can find a post, comment, review or proposal
 * without waiting for a report. Public names and excerpts only (no e-mail, no account ids); acting
 * on an item goes through the existing moderation endpoints.
 */
@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ContentQuery) {
    const term = q.q?.trim();
    const skip = (q.page - 1) * q.pageSize;
    const page = { skip, take: q.pageSize };
    const reportCount = { reports: { where: OPEN_REPORT } } as const;
    const out = async <T>(total: number, rows: T[], map: (row: T) => Record<string, unknown>) => ({
      items: rows.map(map),
      page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize),
    });
    const contains = (field: string) => ({ [field]: { contains: term, mode: "insensitive" as const } });

    switch (q.type) {
      case "POST": {
        const where: Prisma.CommunityPostWhereInput = {
          ...(q.status && { status: q.status }), ...(q.reported && { reports: { some: OPEN_REPORT } }),
          ...(term && { OR: [contains("title"), contains("body")] }),
        };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.communityPost.count({ where }),
          this.prisma.communityPost.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page, select: { id: true, title: true, body: true, status: true, createdAt: true, moderationReason: true, author: { select: authorSelect }, _count: { select: { ...reportCount, comments: true } } } }),
        ]);
        return out(total, rows, (r) => ({ type: "POST", id: r.id, status: r.status, title: r.title, ...excerptOf(r.body), author: publicName(r.author), createdAt: r.createdAt, openReports: r._count.reports, moderationReason: r.moderationReason }));
      }
      case "COMMENT": {
        const where: Prisma.PostCommentWhereInput = { ...(q.status && { status: q.status }), ...(q.reported && { reports: { some: OPEN_REPORT } }), ...(term && contains("body")) };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.postComment.count({ where }),
          this.prisma.postComment.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page, select: { id: true, body: true, status: true, createdAt: true, postId: true, moderationReason: true, author: { select: authorSelect }, _count: { select: reportCount } } }),
        ]);
        return out(total, rows, (r) => ({ type: "COMMENT", id: r.id, status: r.status, postId: r.postId, ...excerptOf(r.body), author: publicName(r.author), createdAt: r.createdAt, openReports: r._count.reports, moderationReason: r.moderationReason }));
      }
      case "REVIEW": {
        const where: Prisma.ReviewWhereInput = { ...(q.status && { status: q.status }), ...(q.reported && { reports: { some: OPEN_REPORT } }), ...(term && { OR: [contains("comment"), { workerProfile: { displayName: { contains: term, mode: "insensitive" } } }] }) };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.review.count({ where }),
          this.prisma.review.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page, select: { id: true, rating: true, comment: true, status: true, createdAt: true, moderationReason: true, customer: { select: authorSelect }, workerProfile: { select: { displayName: true } }, _count: { select: reportCount } } }),
        ]);
        return out(total, rows, (r) => ({ type: "REVIEW", id: r.id, status: r.status, rating: r.rating, worker: r.workerProfile.displayName, ...excerptOf(r.comment ?? ""), author: publicName(r.customer), createdAt: r.createdAt, openReports: r._count.reports, moderationReason: r.moderationReason }));
      }
      case "PROPOSAL": {
        const where: Prisma.FeatureProposalWhereInput = { ...(q.status && { visibility: q.status }), ...(q.reported && { reports: { some: OPEN_REPORT } }), ...(term && { OR: [contains("title"), contains("description")] }) };
        const [total, rows] = await this.prisma.$transaction([
          this.prisma.featureProposal.count({ where }),
          this.prisma.featureProposal.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page, select: { id: true, title: true, description: true, visibility: true, status: true, createdAt: true, moderationReason: true, author: { select: authorSelect }, _count: { select: { ...reportCount, votes: true } } } }),
        ]);
        return out(total, rows, (r) => ({ type: "PROPOSAL", id: r.id, status: r.visibility, decision: r.status, title: r.title, ...excerptOf(r.description), author: publicName(r.author), createdAt: r.createdAt, openReports: r._count.reports, votes: r._count.votes, moderationReason: r.moderationReason }));
      }
    }
  }
}

function excerptOf(text: string) {
  const e = excerpt(text, 240);
  return { text: e.text, truncated: e.truncated };
}
