import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { canReviewWorker } from "../auth/policies.js";
import type { VerificationStatus } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listWorkers(status: VerificationStatus, page: number) {
    const pageSize = 25;
    const rows = await this.prisma.workerProfile.findMany({
      where: { verificationStatus: status },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        displayName: true,
        submittedAt: true,
        verificationStatus: true,
        user: { select: { email: true } },
        services: { select: { category: { select: { name: true } } } },
      },
    });
    return {
      page,
      workers: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        email: row.user.email,
        submittedAt: row.submittedAt,
        verificationStatus: row.verificationStatus,
        categories: row.services.map((s) => s.category.name),
      })),
    };
  }

  /**
   * Records a reviewer decision. Only PENDING profiles can be reviewed, and a
   * reviewer cannot review their own profile. The decision and reviewer are
   * written to the audit log in the same transaction.
   */
  async reviewWorker(
    admin: AuthContext,
    workerProfileId: string,
    decision: Exclude<VerificationStatus, "NOT_SUBMITTED" | "PENDING">,
    note: string | undefined,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.findUnique({
        where: { id: workerProfileId },
        select: { id: true, userId: true, verificationStatus: true },
      });
      if (!profile) throw new NotFoundException("Worker profile not found");
      if (!canReviewWorker(admin, profile.userId)) {
        throw new ForbiddenException("You cannot review your own profile");
      }
      if (profile.verificationStatus !== "PENDING") {
        throw new ConflictException("Only profiles pending review can be reviewed");
      }

      const updated = await tx.workerProfile.update({
        where: { id: profile.id },
        data: {
          verificationStatus: decision,
          reviewedById: admin.userId,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
        select: { id: true, verificationStatus: true, reviewedAt: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: admin.userId,
          action: "worker.verification.review",
          targetType: "WorkerProfile",
          targetId: profile.id,
          metadata: { decision, hasNote: Boolean(note) },
        },
      });
      return updated;
    });
  }
}
