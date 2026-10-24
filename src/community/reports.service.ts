import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict, isUniqueViolation, unprocessable } from "../bookings/domain-errors.js";
import { assertUnderCap, hoursAgo } from "../common/rate-cap.js";
import type { ReportReason, ReportTargetType } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** At most this many reports per user per rolling 24 hours (abuse control). */
export const REPORTS_PER_DAY = 20;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Files a report. The reporter is the session user. The target must exist and
   * be visible to ordinary users (a hidden/deleted item is a plain 404), a user
   * cannot report their own content, and (reporter, target) is UNIQUE, so the
   * same item cannot be reported twice. Reporting never changes visibility.
   */
  async create(
    auth: AuthContext,
    target: { type: ReportTargetType; id: string },
    input: { reason: ReportReason; details?: string },
  ) {
    assertUnderCap(
      await this.prisma.contentReport.count({ where: { reporterId: auth.userId, createdAt: { gte: hoursAgo(24) } } }),
      REPORTS_PER_DAY,
      "REPORT_LIMIT",
      "You have reached the daily limit for reports. Please try again tomorrow.",
    );

    const owner = await this.resolve(target.type, target.id);
    if (!owner) throw new NotFoundException("Content not found");
    if (owner.authorId === auth.userId) {
      throw unprocessable("CANNOT_REPORT_OWN_CONTENT", "You cannot report your own content");
    }

    const column = { POST: "postId", COMMENT: "commentId", REVIEW: "reviewId", PROPOSAL: "proposalId" }[target.type];
    try {
      const report = await this.prisma.contentReport.create({
        data: {
          reporterId: auth.userId,
          targetType: target.type,
          targetKey: `${target.type}:${target.id}`,
          [column]: target.id,
          reason: input.reason,
          details: input.details ?? null,
        },
        select: { id: true, status: true, createdAt: true },
      });
      return { report };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("ALREADY_REPORTED", "You have already reported this content");
      throw error;
    }
  }

  private async resolve(type: ReportTargetType, id: string): Promise<{ authorId: string } | null> {
    switch (type) {
      case "POST": {
        const row = await this.prisma.communityPost.findFirst({ where: { id, status: "VISIBLE" }, select: { authorId: true } });
        return row;
      }
      case "COMMENT": {
        const row = await this.prisma.postComment.findFirst({
          where: { id, status: "VISIBLE", post: { status: "VISIBLE" } },
          select: { authorId: true },
        });
        return row;
      }
      case "REVIEW": {
        const row = await this.prisma.review.findFirst({ where: { id, status: "VISIBLE" }, select: { customerId: true } });
        return row ? { authorId: row.customerId } : null;
      }
      case "PROPOSAL": {
        const row = await this.prisma.featureProposal.findFirst({ where: { id, visibility: "VISIBLE" }, select: { authorId: true } });
        return row;
      }
    }
  }
}
