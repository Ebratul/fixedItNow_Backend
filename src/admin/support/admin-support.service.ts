import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, forbidden, unprocessable } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { NotificationsService } from "../../notifications/notifications.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { TICKET_TRANSITIONS, type TicketStatusName } from "../../support/support.schemas.js";
import { AuditService } from "../audit/audit.service.js";
import { expandPermissions } from "../permissions.js";

export type AdminTicketQuery = {
  status?: string;
  priority?: string;
  category?: string;
  assignee?: string; // "me" | "unassigned" | user id
  q?: string;
  page: number;
  pageSize: number;
};
export type AdminTicketPatch = { status?: TicketStatusName; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"; assigneeId?: string | null; resolution?: string };

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(admin: AuthContext, q: AdminTicketQuery) {
    const term = q.q?.trim();
    const where: Prisma.SupportTicketWhereInput = {
      ...(q.status && { status: q.status as never }),
      ...(q.priority && { priority: q.priority as never }),
      ...(q.category && { category: q.category as never }),
      ...(q.assignee === "me" && { assigneeId: admin.userId }),
      ...(q.assignee === "unassigned" && { assigneeId: null }),
      ...(q.assignee && q.assignee !== "me" && q.assignee !== "unassigned" && { assigneeId: q.assignee }),
      ...(term && { OR: [{ subject: { contains: term, mode: "insensitive" } }, ...(/^#?\d{1,9}$/.test(term) ? [{ number: Number(term.replace("#", "")) }] : [])] }),
    };
    const [total, rows, counts] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        // oldest activity first within the same urgency: the queue is worked from the top
        orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, number: true, category: true, priority: true, subject: true, status: true, bookingId: true, createdAt: true, lastMessageAt: true,
          requester: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.supportTicket.groupBy({ by: ["status"], where: { ...where, status: undefined }, _count: { _all: true } }),
    ]);
    rows.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
    return {
      tickets: rows.map(({ _count, ...t }) => ({ ...t, messageCount: _count.messages })),
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize),
    };
  }

  async get(admin: AuthContext, id: string) {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: {
        id: true, number: true, category: true, priority: true, subject: true, status: true, bookingId: true, resolution: true, resolvedAt: true,
        createdAt: true, updatedAt: true, lastMessageAt: true,
        requester: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } },
        booking: { select: { id: true, status: true, category: { select: { name: true } }, customer: { select: { id: true, name: true } }, workerProfile: { select: { id: true, displayName: true } } } },
        messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 300, select: { id: true, authorRole: true, body: true, internal: true, createdAt: true, author: { select: { name: true } } } },
      },
    });
    if (!t) throw new NotFoundException("Ticket not found");
    const { messages, booking, ...rest } = t;
    return {
      ticket: {
        ...rest,
        isOwn: t.requester.id === admin.userId,
        allowedNext: TICKET_TRANSITIONS[t.status],
        booking: booking ? { id: booking.id, status: booking.status, service: booking.category.name, customer: booking.customer, worker: { id: booking.workerProfile.id, displayName: booking.workerProfile.displayName } } : null,
        messages: messages.map((m) => ({ id: m.id, from: m.authorRole === "ADMIN" ? "staff" : "requester", author: m.author.name, body: m.body, internal: m.internal, createdAt: m.createdAt })),
      },
    };
  }

  /** Staff cannot handle a ticket they raised themselves. */
  private notOwn(admin: AuthContext, requesterId: string) {
    if (requesterId === admin.userId) throw forbidden("OWN_TICKET", "You cannot handle a request you raised yourself");
  }

  async reply(admin: AuthContext, id: string, body: string, internal: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id }, select: { id: true, number: true, requesterId: true, status: true, assigneeId: true } });
      if (!ticket) throw new NotFoundException("Ticket not found");
      this.notOwn(admin, ticket.requesterId);
      if (ticket.status === "CLOSED") throw conflict("TICKET_CLOSED", "A closed ticket cannot be answered");
      await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: admin.userId, authorRole: "ADMIN", body, internal } });
      // A visible reply hands the ball to the requester; a private note changes nothing but the activity time.
      const data: Prisma.SupportTicketUncheckedUpdateInput = { lastMessageAt: new Date() };
      if (!internal) {
        if (ticket.status === "OPEN" || ticket.status === "IN_PROGRESS") data.status = "WAITING_FOR_USER";
        if (!ticket.assigneeId) data.assigneeId = admin.userId;
        await this.notifications.notify(tx, { userId: ticket.requesterId, type: "support.reply", title: `New reply on your request #${ticket.number}`, body: "Our team answered your support request. Open it to read the reply.", link: `/account/support/${id}` });
      }
      await tx.supportTicket.update({ where: { id }, data });
      await this.audit.record(tx, { actorId: admin.userId, action: internal ? "support.note" : "support.reply", targetType: "SupportTicket", targetId: id, metadata: { length: body.length } });
    });
    return this.get(admin, id);
  }

  async update(admin: AuthContext, id: string, patch: AdminTicketPatch) {
    await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id }, select: { id: true, number: true, requesterId: true, status: true, priority: true, assigneeId: true } });
      if (!ticket) throw new NotFoundException("Ticket not found");
      this.notOwn(admin, ticket.requesterId);
      const data: Prisma.SupportTicketUncheckedUpdateInput = {};
      const changes: Record<string, unknown> = {};

      if (patch.status && patch.status !== ticket.status) {
        if (!TICKET_TRANSITIONS[ticket.status].includes(patch.status)) throw conflict("INVALID_TRANSITION", `A ${ticket.status.toLowerCase().replaceAll("_", " ")} ticket cannot become ${patch.status.toLowerCase().replaceAll("_", " ")}`);
        if (patch.status === "RESOLVED" && !patch.resolution) throw unprocessable("RESOLUTION_REQUIRED", "Write the resolution the requester will see");
        data.status = patch.status;
        changes.status = { from: ticket.status, to: patch.status };
        if (patch.status === "RESOLVED" || patch.status === "CLOSED") data.resolvedAt = new Date();
        else data.resolvedAt = null;
        if (patch.status === "RESOLVED") {
          data.resolution = patch.resolution;
          await this.notifications.notify(tx, { userId: ticket.requesterId, type: "support.resolved", title: `Your request #${ticket.number} was resolved`, body: patch.resolution!.slice(0, 300), link: `/account/support/${id}` });
        }
      } else if (patch.status && patch.status === ticket.status) {
        throw conflict("NO_CHANGE", "The ticket already has that status");
      }
      if (patch.priority && patch.priority !== ticket.priority) { data.priority = patch.priority; changes.priority = { from: ticket.priority, to: patch.priority }; }
      if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
        if (patch.assigneeId !== null) {
          const staff = await tx.user.findUnique({ where: { id: patch.assigneeId }, select: { role: true, suspendedAt: true, adminRole: { select: { permissions: true } } } });
          const allowed = staff?.role === "ADMIN" && !staff.suspendedAt && staff.adminRole && expandPermissions(staff.adminRole.permissions).has("support.manage");
          if (!allowed) throw unprocessable("INVALID_ASSIGNEE", "Tickets can only be assigned to active staff who can handle support");
        }
        data.assigneeId = patch.assigneeId;
        changes.assigneeId = { from: ticket.assigneeId, to: patch.assigneeId };
      }
      if (Object.keys(changes).length === 0) throw conflict("NO_CHANGE", "Nothing to change");
      const { count } = await tx.supportTicket.updateMany({ where: { id, status: ticket.status }, data });
      if (count === 0) throw conflict("STALE_TICKET", "This ticket just changed. Refresh and try again.");
      await this.audit.record(tx, { actorId: admin.userId, action: "support.update", targetType: "SupportTicket", targetId: id, metadata: { number: ticket.number, changes } });
    });
    return this.get(admin, id);
  }

  /** Staff who can take tickets, for the assignee picker. */
  async assignees() {
    const rows = await this.prisma.user.findMany({
      where: { role: "ADMIN", suspendedAt: null, adminRole: { isNot: null } },
      select: { id: true, name: true, adminRole: { select: { permissions: true } } },
      orderBy: { name: "asc" },
      take: 200,
    });
    return { staff: rows.filter((r) => expandPermissions(r.adminRole!.permissions).has("support.manage")).map((r) => ({ id: r.id, name: r.name })) };
  }
}
