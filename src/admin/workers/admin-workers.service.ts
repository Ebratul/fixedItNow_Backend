import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { canReviewWorker } from "../../auth/policies.js";
import { conflict, forbidden, unprocessable } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { VerificationStatus } from "../../generated/prisma/enums.js";
import { NotificationsService } from "../../notifications/notifications.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { REQUIRED_KINDS } from "../../worker/worker-documents.service.js";
import { AuditService } from "../audit/audit.service.js";
import { SettingsService } from "../settings/settings.service.js";

export type WorkerListQuery = {
  status: VerificationStatus | "ALL";
  q?: string;
  published?: boolean;
  suspended?: boolean;
  page: number;
  pageSize: number;
};

const DECISION_COPY: Record<"VERIFIED" | "REJECTED" | "RESUBMISSION_REQUIRED", { title: string; body: string }> = {
  VERIFIED: { title: "Your worker profile was approved", body: "You can now publish your profile and receive booking requests." },
  REJECTED: { title: "Your worker application was not approved", body: "Open your account to read the reviewer's reason." },
  RESUBMISSION_REQUIRED: { title: "Your worker application needs changes", body: "Open your account to read what to fix, then submit again." },
};

@Injectable()
export class AdminWorkersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: WorkerListQuery) {
    const where: Prisma.WorkerProfileWhereInput = {
      ...(q.status !== "ALL" && { verificationStatus: q.status }),
      ...(q.q && { OR: [{ displayName: { contains: q.q, mode: "insensitive" } }, { user: { email: { contains: q.q, mode: "insensitive" } } }, { user: { name: { contains: q.q, mode: "insensitive" } } }] }),
      ...(q.published === true && { publishedAt: { not: null } }),
      ...(q.published === false && { publishedAt: null }),
      ...(q.suspended === true && { suspendedAt: { not: null } }),
      ...(q.suspended === false && { suspendedAt: null }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.workerProfile.count({ where }),
      this.prisma.workerProfile.findMany({
        where,
        orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, displayName: true, submittedAt: true, verificationStatus: true, publishedAt: true, suspendedAt: true,
          user: { select: { email: true } },
          services: { select: { category: { select: { name: true } } } },
          _count: { select: { documents: true } },
        },
      }),
    ]);
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
      workers: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        email: row.user.email,
        submittedAt: row.submittedAt,
        verificationStatus: row.verificationStatus,
        published: row.publishedAt !== null,
        suspended: row.suspendedAt !== null,
        categories: row.services.map((s) => s.category.name),
        documentCount: row._count.documents,
      })),
    };
  }

  async get(admin: AuthContext, id: string) {
    const p = await this.prisma.workerProfile.findUnique({
      where: { id },
      select: {
        id: true, userId: true, onboardingStatus: true, displayName: true, headline: true, bio: true, experienceYears: true, languages: true, serviceAreas: true,
        submittedAt: true, verificationStatus: true, reviewNote: true, reviewedAt: true, reviewedBy: { select: { name: true } },
        publishedAt: true, slug: true, suspendedAt: true, suspensionReason: true, startingPriceBdt: true,
        user: { select: { id: true, name: true, email: true, suspendedAt: true } },
        services: { select: { pricingModel: true, basePriceBdt: true, category: { select: { name: true, slug: true } } } },
        documents: { select: { kind: true, mimeType: true, sizeBytes: true, uploadedAt: true }, orderBy: { kind: "asc" } },
      },
    });
    if (!p) throw new NotFoundException("Worker profile not found");
    const history = await this.prisma.auditLog.findMany({
      where: { targetType: "WorkerProfile", targetId: id, action: { in: ["worker.verification.review", "worker.suspend", "worker.unsuspend", "worker.document.view"] } },
      orderBy: { seq: "desc" },
      take: 20,
      select: { id: true, action: true, createdAt: true, metadata: true, actor: { select: { name: true } } },
    });
    const requireDocs = await this.settings.get("workers.requireIdentityDocuments");
    const { user, reviewedBy, ...profile } = p;
    return {
      worker: {
        ...profile,
        published: p.publishedAt !== null,
        suspended: p.suspendedAt !== null,
        reviewedBy: reviewedBy?.name ?? null,
        user: { id: user.id, name: user.name, email: user.email, suspended: user.suspendedAt !== null },
        isOwnProfile: p.userId === admin.userId,
        documentsRequired: requireDocs,
        missingDocuments: requireDocs ? REQUIRED_KINDS.filter((k) => !p.documents.some((d) => d.kind === k)) : [],
        history: history.map((h) => ({ id: h.id, action: h.action, at: h.createdAt, by: h.actor?.name ?? "system", detail: (h.metadata as Record<string, unknown> | null) ?? null })),
      },
    };
  }

  /**
   * Records a reviewer decision. Only PENDING profiles can be reviewed, and a reviewer cannot review
   * their own profile. The decision, the audit row and the worker's notification are written in the
   * same transaction.
   */
  async review(admin: AuthContext, workerProfileId: string, decision: "VERIFIED" | "REJECTED" | "RESUBMISSION_REQUIRED", note: string | undefined) {
    const requireDocs = decision === "VERIFIED" && (await this.settings.get("workers.requireIdentityDocuments"));
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.findUnique({
        where: { id: workerProfileId },
        select: { id: true, userId: true, verificationStatus: true, documents: { select: { kind: true } } },
      });
      if (!profile) throw new NotFoundException("Worker profile not found");
      if (!canReviewWorker(admin, profile.userId)) throw forbidden("OWN_PROFILE", "You cannot review your own profile");
      if (profile.verificationStatus !== "PENDING") throw conflict("NOT_PENDING", "Only profiles pending review can be reviewed");
      if (requireDocs) {
        const missing = REQUIRED_KINDS.filter((k) => !profile.documents.some((d) => d.kind === k));
        if (missing.length) throw unprocessable("DOCUMENTS_REQUIRED", "Both sides of the identity document must be uploaded before this worker can be verified");
      }
      // Conditional on still being PENDING: two admins deciding at once must not both succeed.
      const decided = await tx.workerProfile.updateMany({
        where: { id: profile.id, verificationStatus: "PENDING" },
        data: { verificationStatus: decision, reviewedById: admin.userId, reviewedAt: new Date(), reviewNote: note ?? null },
      });
      if (decided.count !== 1) throw conflict("NOT_PENDING", "Only profiles pending review can be reviewed");
      const updated = await tx.workerProfile.findUniqueOrThrow({ where: { id: profile.id }, select: { id: true, verificationStatus: true, reviewedAt: true } });
      await this.audit.record(tx, {
        actorId: admin.userId, action: "worker.verification.review", targetType: "WorkerProfile", targetId: profile.id,
        metadata: { decision, hasNote: Boolean(note), note: note ?? null },
      });
      const copy = DECISION_COPY[decision];
      await this.notifications.notify(tx, { userId: profile.userId, type: "worker.verification", title: copy.title, body: note && decision !== "VERIFIED" ? `${copy.body} Reviewer note: ${note}` : copy.body, link: "/account" });
      return updated;
    });
  }

  /**
   * Suspend or restore a profile. While suspended it is hidden from every public read (see
   * ELIGIBLE_WORKER) and cannot be published. The reason is an internal moderation note and is never
   * returned by any public or owner API.
   */
  async setSuspension(admin: AuthContext, workerProfileId: string, suspended: boolean, reason: string | undefined) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.findUnique({ where: { id: workerProfileId }, select: { id: true, userId: true, suspendedAt: true } });
      if (!profile) throw new NotFoundException("Worker profile not found");
      if (!canReviewWorker(admin, profile.userId)) throw forbidden("OWN_PROFILE", "You cannot moderate your own profile");
      const updated = await tx.workerProfile.update({
        where: { id: profile.id },
        data: { suspendedAt: suspended ? new Date() : null, suspensionReason: suspended ? (reason ?? null) : null },
        select: { id: true, suspendedAt: true },
      });
      await this.audit.record(tx, {
        actorId: admin.userId, action: suspended ? "worker.suspend" : "worker.unsuspend", targetType: "WorkerProfile", targetId: profile.id,
        metadata: { hasReason: Boolean(reason), reason: reason ?? null },
      });
      return { id: updated.id, suspended: updated.suspendedAt !== null };
    });
  }
}
