import { Injectable, Logger } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { BookingCore, customerName, type Loaded } from "../bookings/booking-core.service.js";
import { Clock } from "../bookings/clock.js";
import { conflict, unprocessable } from "../bookings/domain-errors.js";
import { isListable } from "../workers/eligibility.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { chatAccess } from "./chat.access.js";
import { CHAT_PAGE_SIZE, MAX_MESSAGES_PER_BOOKING, type ListMessagesQuery, type SendMessageInput } from "./chat.schemas.js";

type Row = { id: string; seq: number; senderId: string; senderRole: "CUSTOMER" | "WORKER" | "ADMIN" | "SYSTEM"; body: string; clientMessageId: string; createdAt: Date };

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: BookingCore,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
  ) {}

  private present(row: Row, userId: string) {
    const mine = row.senderId === userId;
    return {
      id: row.id,
      seq: row.seq,
      senderRole: row.senderRole as "CUSTOMER" | "WORKER",
      mine,
      body: row.body,
      createdAt: row.createdAt,
      // Only the author gets the key back, so the browser can match its own pending copy.
      ...(mine && { clientMessageId: row.clientMessageId }),
    };
  }

  private counterparty({ booking, viewer }: Loaded) {
    return viewer === "CUSTOMER"
      ? { displayName: booking.workerProfile.displayName ?? "Professional", role: "WORKER" as const, slug: isListable(booking.workerProfile) ? booking.workerProfile.slug : null }
      : { displayName: customerName(booking), role: "CUSTOMER" as const, slug: null };
  }

  /**
   * The conversation as one participant sees it. Anyone else (another customer, another worker, an
   * admin who is not a party, an unknown id) gets the booking's 404. Before the booking is accepted
   * there is no conversation yet: 409 CHAT_NOT_AVAILABLE, never an empty list that looks like "no messages".
   */
  async thread(auth: AuthContext, bookingId: string, query: ListMessagesQuery) {
    const loaded = await this.core.loadParticipant(this.prisma, auth.userId, bookingId);
    const access = chatAccess(loaded.booking, this.clock.now());
    if (!access.canRead) throw conflict("CHAT_NOT_AVAILABLE", access.reason ?? "There is no conversation for this booking.");

    // Newest page first, shown oldest-first. Ordered by `seq` (a database sequence), never by timestamp.
    const rows = await this.prisma.chatMessage.findMany({
      where: { bookingId, ...(query.before && { seq: { lt: query.before } }) },
      orderBy: { seq: "desc" },
      take: CHAT_PAGE_SIZE + 1,
      select: { id: true, seq: true, senderId: true, senderRole: true, body: true, clientMessageId: true, createdAt: true },
    });
    const hasMore = rows.length > CHAT_PAGE_SIZE;
    const page = rows.slice(0, CHAT_PAGE_SIZE).reverse();
    return {
      chat: { state: access.state, reason: access.reason },
      counterparty: this.counterparty(loaded),
      messages: page.map((r) => this.present(r, auth.userId)),
      hasMore,
    };
  }

  /**
   * Store one message. Everything about the sender comes from the session and the booking:
   * the body carries only text and a client-chosen idempotency key. The booking row is locked
   * (FOR SHARE) while we check the state and insert, so a cancel or dispute cannot slip in between.
   */
  async send(auth: AuthContext, bookingId: string, input: SendMessageInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const first = await this.core.loadParticipant(tx, auth.userId, bookingId);
      await tx.$queryRaw`SELECT id FROM booking WHERE id = ${first.booking.id} FOR SHARE`;
      const loaded = await this.core.loadParticipant(tx, auth.userId, bookingId);
      const now = this.clock.now();

      const existing = await tx.chatMessage.findUnique({
        where: { bookingId_senderId_clientMessageId: { bookingId, senderId: auth.userId, clientMessageId: input.clientMessageId } },
        select: { id: true, seq: true, senderId: true, senderRole: true, body: true, clientMessageId: true, createdAt: true },
      });
      if (existing) {
        // A retry of a message we already stored: same answer, no second row. Same key, other text: a client bug.
        if (existing.body !== input.body) throw conflict("IDEMPOTENCY_KEY_REUSED", "That message key was already used for a different message");
        return { row: existing, created: false, loaded };
      }

      const access = chatAccess(loaded.booking, now);
      if (!access.canSend) throw conflict(access.canRead ? "CHAT_READ_ONLY" : "CHAT_NOT_AVAILABLE", access.reason ?? "There is no conversation for this booking.");
      if ((await tx.chatMessage.count({ where: { bookingId } })) >= MAX_MESSAGES_PER_BOOKING) {
        throw unprocessable("CHAT_LIMIT_REACHED", "This conversation has reached its message limit. Please use the dispute or support channel instead.");
      }

      // ON CONFLICT DO NOTHING: two identical retries racing each other insert one row; the loser re-reads it.
      const { count } = await tx.chatMessage.createMany({
        data: [{ bookingId, senderId: auth.userId, senderRole: loaded.viewer, body: input.body, clientMessageId: input.clientMessageId, createdAt: now }],
        skipDuplicates: true,
      });
      const row = await tx.chatMessage.findUniqueOrThrow({
        where: { bookingId_senderId_clientMessageId: { bookingId, senderId: auth.userId, clientMessageId: input.clientMessageId } },
        select: { id: true, seq: true, senderId: true, senderRole: true, body: true, clientMessageId: true, createdAt: true },
      });
      return { row, created: count === 1, loaded };
    });

    if (result.created) await this.notifyRecipient(result.loaded, auth.userId);
    return { message: this.present(result.row, auth.userId), created: result.created };
  }

  /**
   * One unread "new message" notification per conversation: a chatty exchange must not bury the
   * recipient's inbox. Runs after the message is committed; a failure here never loses the message.
   */
  private async notifyRecipient({ booking, viewer }: Loaded, senderId: string) {
    try {
      const recipientId = viewer === "CUSTOMER" ? booking.workerProfile.userId : booking.customerId;
      if (recipientId === senderId) return;
      const link = `/bookings/${booking.id}?chat=1`;
      const unread = await this.prisma.notification.findFirst({ where: { userId: recipientId, type: "chat.message", link, readAt: null }, select: { id: true } });
      if (unread) return;
      const from = viewer === "CUSTOMER" ? customerName(booking) : (booking.workerProfile.displayName ?? "The professional");
      await this.notifications.notify(this.prisma, {
        userId: recipientId,
        type: "chat.message",
        title: `New message from ${from}`,
        body: `You have a new message about your ${booking.category.name} booking.`,
        link,
      });
    } catch (error) {
      this.log.warn(`chat notification failed for booking ${booking.id}: ${error instanceof Error ? error.name : "error"}`);
    }
  }
}
