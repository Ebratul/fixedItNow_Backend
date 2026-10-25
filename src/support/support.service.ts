import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../admin/audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict } from "../bookings/domain-errors.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MAX_OPEN_TICKETS, type CreateTicketInput } from "./support.schemas.js";

const OPEN_STATES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER"] as const;

/** What the requester may see of a ticket: no priority, no assignee, no internal notes. */
const ownSelect = {
  id: true, number: true, category: true, subject: true, status: true, bookingId: true, resolution: true,
  createdAt: true, updatedAt: true, lastMessageAt: true,
} satisfies Prisma.SupportTicketSelect;

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, input: CreateTicketInput) {
    return this.prisma.$transaction(async (tx) => {
      if (input.bookingId) {
        // Only a party to the booking may raise a ticket about it (and learn that it exists).
        const booking = await tx.booking.findFirst({
          where: { id: input.bookingId, OR: [{ customerId: auth.userId }, { workerProfile: { userId: auth.userId } }] },
          select: { id: true },
        });
        if (!booking) throw new NotFoundException("Booking not found");
      }
      // Serialise one user's creations so the open-ticket cap cannot be beaten by parallel requests.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support:${auth.userId}`}))`;
      const open = await tx.supportTicket.count({ where: { requesterId: auth.userId, status: { in: [...OPEN_STATES] } } });
      if (open >= MAX_OPEN_TICKETS) {
        throw conflict("TOO_MANY_OPEN_TICKETS", `You already have ${MAX_OPEN_TICKETS} open requests. Please wait for a reply or close one first.`);
      }
      const ticket = await tx.supportTicket.create({
        data: {
          requesterId: auth.userId, category: input.category, subject: input.subject, bookingId: input.bookingId ?? null,
          messages: { create: { authorId: auth.userId, authorRole: "CUSTOMER", body: input.body } },
        },
        select: ownSelect,
      });
      return { ticket };
    });
  }

  async list(auth: AuthContext, q: { status?: string; page: number; pageSize: number }) {
    const where: Prisma.SupportTicketWhereInput = { requesterId: auth.userId, ...(q.status && { status: q.status as never }) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: ownSelect }),
    ]);
    return { tickets: rows, page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) };
  }

  /** Someone else's ticket is indistinguishable from a missing one. */
  async get(auth: AuthContext, id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, requesterId: auth.userId },
      select: {
        ...ownSelect,
        messages: { where: { internal: false }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 300, select: { id: true, authorRole: true, body: true, createdAt: true } },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return { ticket: { ...ticket, messages: ticket.messages.map((m) => ({ ...m, fromStaff: m.authorRole === "ADMIN" })) } };
  }

  async reply(auth: AuthContext, id: string, body: string) {
    await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findFirst({ where: { id, requesterId: auth.userId }, select: { id: true, status: true } });
      if (!ticket) throw new NotFoundException("Ticket not found");
      if (ticket.status === "CLOSED") throw conflict("TICKET_CLOSED", "This request is closed. Please open a new one.");
      // authorRole CUSTOMER means "the requester" here, whether they raised it as a customer or a worker.
      await tx.supportTicketMessage.create({ data: { ticketId: id, authorId: auth.userId, authorRole: "CUSTOMER", body } });
      // A user's reply puts a waiting or resolved ticket back in front of staff.
      const reopen = ticket.status === "WAITING_FOR_USER" || ticket.status === "RESOLVED";
      await tx.supportTicket.update({ where: { id }, data: { lastMessageAt: new Date(), ...(reopen && { status: "OPEN", resolvedAt: null }) } });
    });
    return this.get(auth, id);
  }

  async close(auth: AuthContext, id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id, requesterId: auth.userId }, select: { id: true, status: true } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (ticket.status === "CLOSED") throw conflict("TICKET_CLOSED", "This request is already closed.");
    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({ where: { id }, data: { status: "CLOSED", resolvedAt: new Date() } });
      await this.audit.record(tx, { actorId: auth.userId, action: "support.close_by_requester", targetType: "SupportTicket", targetId: id, metadata: { from: ticket.status } });
    });
    return this.get(auth, id);
  }
}
