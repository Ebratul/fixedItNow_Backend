import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

type Db = Prisma.TransactionClient | PrismaService;

export type NewNotification = {
  userId: string;
  /** machine type, e.g. "support.reply", "worker.verification", "admin.message" */
  type: string;
  title: string;
  body: string;
  /** In-app path only (the database rejects anything else). */
  link?: string | null;
};

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Announce something that has ALREADY been committed. Call it after the transaction, never inside it:
   * a notification that cannot be stored must not undo a booking, a payment or a review. Each notice is
   * tried twice; a final failure is logged (type and recipient only, never the text) and swallowed.
   * In-app only: no email or push is sent, so nothing here can claim a message was delivered elsewhere.
   * Returns how many notices could not be stored.
   */
  async notifyBestEffort(notices: NewNotification[]): Promise<number> {
    let failed = 0;
    for (const n of notices) {
      let stored = false;
      for (let attempt = 1; attempt <= 2 && !stored; attempt++) {
        try {
          await this.notify(this.prisma, n);
          stored = true;
        } catch (error) {
          if (attempt === 2) this.log.error(`notification not stored: type=${n.type} user=${n.userId} (${error instanceof Error ? error.name : "error"})`);
        }
      }
      if (!stored) failed++;
    }
    return failed;
  }

  /** Create a notification; pass the caller's transaction client so it commits with the change it announces. */
  notify(db: Db, n: NewNotification) {
    return db.notification.create({
      data: { userId: n.userId, type: n.type, title: n.title.slice(0, 120), body: n.body.slice(0, 1000), link: n.link ?? null },
    });
  }

  async list(userId: string, q: { unread?: boolean; page: number; pageSize: number }) {
    const where: Prisma.NotificationWhereInput = { userId, ...(q.unread && { readAt: null }) };
    const [total, unreadCount, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.findMany({
        where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
      }),
    ]);
    return { notifications: rows, unreadCount, page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) };
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string) {
    // Scoped to the owner: someone else's notification looks like a missing one.
    const { count } = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } }))) throw new NotFoundException("Notification not found");
    return { unreadCount: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { unreadCount: 0 };
  }
}
