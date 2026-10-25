import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, unprocessable } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { NotificationsService } from "../../notifications/notifications.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

export type AnnouncementInput = { title: string; body: string; audience: "ALL" | "CUSTOMERS" | "WORKERS"; severity: "INFO" | "WARNING" | "CRITICAL"; startsAt?: Date | null; endsAt?: Date | null };

const select = {
  id: true, title: true, body: true, audience: true, severity: true, status: true, startsAt: true, endsAt: true, publishedAt: true,
  createdAt: true, updatedAt: true, createdBy: { select: { name: true } },
} satisfies Prisma.AnnouncementSelect;
const present = ({ createdBy, ...a }: Prisma.AnnouncementGetPayload<{ select: typeof select }>, now = new Date()) => ({
  ...a,
  createdBy: createdBy.name,
  // "live" is what readers see right now; PUBLISHED outside its window is scheduled or expired
  live: a.status === "PUBLISHED" && (!a.startsAt || a.startsAt <= now) && (!a.endsAt || a.endsAt > now),
});

@Injectable()
export class AnnouncementsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: { status?: string; page: number; pageSize: number }) {
    const where: Prisma.AnnouncementWhereInput = q.status ? { status: q.status as never } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.announcement.count({ where }),
      this.prisma.announcement.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select }),
    ]);
    return { announcements: rows.map((r) => present(r)), page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) };
  }

  private checkWindow(startsAt: Date | null | undefined, endsAt: Date | null | undefined) {
    if (startsAt && endsAt && endsAt <= startsAt) throw unprocessable("BAD_WINDOW", "The end must be after the start");
  }

  async create(admin: AuthContext, input: AnnouncementInput) {
    this.checkWindow(input.startsAt, input.endsAt);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.announcement.create({
        data: { title: input.title, body: input.body, audience: input.audience, severity: input.severity, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, createdById: admin.userId },
        select,
      });
      await this.audit.record(tx, { actorId: admin.userId, action: "announcement.create", targetType: "Announcement", targetId: row.id, metadata: { title: row.title, audience: row.audience, severity: row.severity } });
      return { announcement: present(row) };
    });
  }

  async update(admin: AuthContext, id: string, patch: Partial<AnnouncementInput>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.announcement.findUnique({ where: { id }, select });
      if (!before) throw new NotFoundException("Announcement not found");
      if (before.status === "ARCHIVED") throw conflict("ARCHIVED", "An archived announcement cannot be edited");
      this.checkWindow(patch.startsAt === undefined ? before.startsAt : patch.startsAt, patch.endsAt === undefined ? before.endsAt : patch.endsAt);
      const row = await tx.announcement.update({ where: { id }, data: patch, select });
      await this.audit.record(tx, { actorId: admin.userId, action: "announcement.update", targetType: "Announcement", targetId: id, metadata: { fields: Object.keys(patch), wasStatus: before.status } });
      return { announcement: present(row) };
    });
  }

  /** Publishing is a broadcast to real users: it needs `confirm` and cannot be done twice or on an expired window. */
  async publish(admin: AuthContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.announcement.findUnique({ where: { id }, select });
      if (!before) throw new NotFoundException("Announcement not found");
      if (before.status !== "DRAFT") throw conflict("NOT_DRAFT", before.status === "PUBLISHED" ? "This announcement is already published" : "An archived announcement cannot be published");
      if (before.endsAt && before.endsAt <= new Date()) throw unprocessable("ALREADY_EXPIRED", "The end time has passed; edit it first");
      const row = await tx.announcement.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() }, select });
      await this.audit.record(tx, { actorId: admin.userId, action: "announcement.publish", targetType: "Announcement", targetId: id, metadata: { title: row.title, audience: row.audience, severity: row.severity } });
      return { announcement: present(row) };
    });
  }

  async archive(admin: AuthContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.announcement.findUnique({ where: { id }, select });
      if (!before) throw new NotFoundException("Announcement not found");
      if (before.status === "ARCHIVED") throw conflict("ALREADY_ARCHIVED", "Already archived");
      const row = await tx.announcement.update({ where: { id }, data: { status: "ARCHIVED" }, select });
      await this.audit.record(tx, { actorId: admin.userId, action: "announcement.archive", targetType: "Announcement", targetId: id, metadata: { title: row.title, wasStatus: before.status } });
      return { announcement: present(row) };
    });
  }

  /** A personal notification from staff to one user (e.g. a follow-up on a case). */
  async sendToUser(admin: AuthContext, input: { userId: string; title: string; body: string; link?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, suspendedAt: true } });
      if (!user) throw new NotFoundException("User not found");
      const n = await this.notifications.notify(tx, { userId: user.id, type: "admin.message", title: input.title, body: input.body, link: input.link });
      await this.audit.record(tx, { actorId: admin.userId, action: "notification.send", targetType: "User", targetId: user.id, metadata: { notificationId: n.id, title: input.title, hasLink: Boolean(input.link) } });
      return { notification: { id: n.id, createdAt: n.createdAt } };
    });
  }
}
