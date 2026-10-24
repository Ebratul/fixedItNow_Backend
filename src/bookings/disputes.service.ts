import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import type { ActorRole, DisputeCategory, DisputeOutcome, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { lockWorker } from "./availability.service.js";
import { BookingCore, customerName } from "./booking-core.service.js";
import { BookingsService } from "./bookings.service.js";
import { conflict, forbidden, isUniqueViolation } from "./domain-errors.js";
import { ACTIVE_DISPUTE, canDisputeTransition, DISPUTE_TRANSITIONS, type DisputeAction } from "./dispute.state.js";

type Tx = Prisma.TransactionClient;

/**
 * Disputes are text-only: there is no private file storage yet, so no evidence
 * upload exists (and none is faked). Resolution changes the BOOKING outcome
 * only; it never moves money (payments arrive in Step 6).
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly core: BookingCore,
    private readonly bookings: BookingsService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------- participants

  open(auth: AuthContext, bookingId: string, input: { category: DisputeCategory; description: string }) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }, now) => {
      const status = booking.status;
      if (!this.core.canOpenDispute(booking, status, now)) {
        throw conflict("DISPUTE_NOT_ALLOWED", "A dispute cannot be opened for this booking right now");
      }
      const existing = await tx.dispute.findUnique({ where: { bookingId: booking.id }, select: { id: true } });
      if (existing) throw conflict("DISPUTE_EXISTS", "A dispute was already opened for this booking");
      const role: ActorRole = viewer;
      try {
        await tx.dispute.create({
          data: {
            bookingId: booking.id,
            openedByUserId: auth.userId,
            openedByRole: role,
            category: input.category,
            description: input.description,
            previousBookingStatus: status,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("DISPUTE_EXISTS", "A dispute was already opened for this booking");
        throw error;
      }
      await this.core.transition(tx, booking, "open_dispute", { userId: auth.userId, role }, {
        eventType: "dispute.opened",
        metadata: { category: input.category },
      });
      await tx.rescheduleRequest.updateMany({
        where: { bookingId: booking.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
    });
  }

  /** Participant view: public messages only, never internal notes or admin ids. */
  async getForParticipant(auth: AuthContext, bookingId: string) {
    await this.core.loadParticipant(this.prisma, auth.userId, bookingId);
    const dispute = await this.prisma.dispute.findUnique({
      where: { bookingId },
      select: {
        id: true,
        category: true,
        description: true,
        status: true,
        openedByRole: true,
        outcome: true,
        resolution: true,
        resolvedAt: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { internal: false },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
          select: { id: true, authorRole: true, body: true, createdAt: true },
        },
      },
    });
    if (!dispute) throw new NotFoundException("No dispute for this booking");
    return { dispute };
  }

  addMessage(auth: AuthContext, bookingId: string, body: string) {
    return this.prisma.$transaction(async (tx) => {
      const { viewer } = await this.core.loadParticipant(tx, auth.userId, bookingId);
      const dispute = await tx.dispute.findUnique({ where: { bookingId } });
      if (!dispute) throw new NotFoundException("No dispute for this booking");
      if (!ACTIVE_DISPUTE.includes(dispute.status)) {
        throw conflict("DISPUTE_CLOSED", "This dispute is closed to new messages");
      }
      await tx.disputeMessage.create({
        data: { disputeId: dispute.id, authorUserId: auth.userId, authorRole: viewer, body },
      });
      if (canDisputeTransition("provide_info", dispute.status)) {
        await this.setStatus(tx, dispute.id, dispute.status, "provide_info");
      }
      return { ok: true };
    });
  }

  /** The person who opened it can withdraw; the booking returns to its previous status. */
  withdraw(auth: AuthContext, bookingId: string) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }) => {
      const dispute = await tx.dispute.findUnique({ where: { bookingId } });
      if (!dispute) throw new NotFoundException("No dispute for this booking");
      if (dispute.openedByUserId !== auth.userId) {
        throw forbidden("NOT_ALLOWED", "Only the person who opened the dispute can withdraw it");
      }
      if (!canDisputeTransition("withdraw", dispute.status)) {
        throw conflict("DISPUTE_CLOSED", "This dispute can no longer be withdrawn");
      }
      await this.setStatus(tx, dispute.id, dispute.status, "withdraw");
      await this.core.transition(tx, booking, "dispute_restore", { userId: auth.userId, role: viewer }, {
        eventType: "dispute.withdrawn",
        previousStatus: dispute.previousBookingStatus,
      });
    });
  }

  private async setStatus(tx: Tx, disputeId: string, from: import("../generated/prisma/client.js").DisputeStatus, action: DisputeAction, data: Prisma.DisputeUncheckedUpdateManyInput = {}) {
    const { count } = await tx.dispute.updateMany({
      where: { id: disputeId, status: from },
      data: { ...data, status: DISPUTE_TRANSITIONS[action].to },
    });
    if (count === 0) throw conflict("STALE_DISPUTE", "This dispute just changed. Refresh and try again.");
  }

  // ---------------------------------------------------------------- admin

  async adminList(status: string | undefined, page: number, pageSize: number) {
    const where: Prisma.DisputeWhereInput = status ? { status: status as never } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.dispute.count({ where }),
      this.prisma.dispute.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          category: true,
          openedByRole: true,
          createdAt: true,
          assignedAdminId: true,
          booking: { select: { id: true, status: true, startAt: true, category: { select: { name: true } } } },
        },
      }),
    ]);
    return { disputes: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }

  /** Everything an admin needs to decide; no emails, phone numbers, or account identifiers. */
  async adminGet(disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 } },
    });
    if (!dispute) throw new NotFoundException("Dispute not found");
    const booking = await this.core.reload(this.prisma, dispute.bookingId);
    const [events, quotes] = await Promise.all([
      this.prisma.bookingEvent.findMany({
        where: { bookingId: booking.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
        select: { type: true, actorRole: true, fromStatus: true, toStatus: true, reason: true, createdAt: true },
      }),
      this.prisma.quote.findMany({
        where: { bookingId: booking.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, totalBdt: true, createdAt: true },
      }),
    ]);
    return {
      dispute: {
        id: dispute.id,
        status: dispute.status,
        category: dispute.category,
        description: dispute.description,
        openedByRole: dispute.openedByRole,
        previousBookingStatus: dispute.previousBookingStatus,
        outcome: dispute.outcome,
        resolution: dispute.resolution,
        resolvedAt: dispute.resolvedAt,
        assignedAdminId: dispute.assignedAdminId,
        createdAt: dispute.createdAt,
        messages: dispute.messages.map((m) => ({
          id: m.id,
          authorRole: m.authorRole,
          body: m.body,
          internal: m.internal,
          createdAt: m.createdAt,
        })),
      },
      booking: {
        id: booking.id,
        status: booking.status,
        category: booking.category,
        description: booking.description,
        serviceArea: booking.serviceArea,
        serviceAddress: booking.serviceAddress,
        startAt: booking.startAt,
        endAt: booking.endAt,
        agreedAmountBdt: booking.agreedAmountBdt,
        currency: booking.currency,
        customerName: customerName(booking),
        workerName: booking.workerProfile.displayName,
      },
      quotes,
      events,
    };
  }

  /** Run an admin action under the worker lock, never for a booking the admin is part of. */
  private async adminAct(
    admin: AuthContext,
    disputeId: string,
    work: (tx: Tx, ctx: { dispute: NonNullable<Awaited<ReturnType<Tx["dispute"]["findUnique"]>>>; booking: Awaited<ReturnType<BookingCore["reload"]>> }, now: Date) => Promise<void>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new NotFoundException("Dispute not found");
      const booking = await this.core.reload(tx, dispute.bookingId);
      if (booking.customerId === admin.userId || booking.workerProfile.userId === admin.userId) {
        throw new ForbiddenException("You cannot moderate a dispute you are part of");
      }
      await lockWorker(tx, booking.workerProfileId);
      await work(tx, { dispute, booking: await this.core.reload(tx, dispute.bookingId) }, this.core.clock.now());
    });
    return this.adminGet(disputeId);
  }

  private audit(tx: Tx, admin: AuthContext, action: string, disputeId: string, metadata?: Prisma.InputJsonValue) {
    return tx.auditLog.create({
      data: { actorId: admin.userId, action, targetType: "Dispute", targetId: disputeId, metadata },
    });
  }

  private requireAction(status: import("../generated/prisma/client.js").DisputeStatus, action: DisputeAction) {
    if (!canDisputeTransition(action, status)) {
      throw conflict("INVALID_DISPUTE_TRANSITION", `Cannot ${action.replaceAll("_", " ")} a dispute that is ${status.toLowerCase().replaceAll("_", " ")}`);
    }
  }

  adminReview(admin: AuthContext, disputeId: string) {
    return this.adminAct(admin, disputeId, async (tx, { dispute }) => {
      this.requireAction(dispute.status, "review");
      await this.setStatus(tx, dispute.id, dispute.status, "review", { assignedAdminId: admin.userId });
      await this.audit(tx, admin, "dispute.review", dispute.id);
      await this.core.event(tx, dispute.bookingId, { userId: admin.userId, role: "ADMIN" }, "dispute.under_review");
    });
  }

  adminRequestInfo(admin: AuthContext, disputeId: string, message: string) {
    return this.adminAct(admin, disputeId, async (tx, { dispute }) => {
      this.requireAction(dispute.status, "request_info");
      await this.setStatus(tx, dispute.id, dispute.status, "request_info");
      await tx.disputeMessage.create({ data: { disputeId: dispute.id, authorUserId: admin.userId, authorRole: "ADMIN", body: message } });
      await this.audit(tx, admin, "dispute.request_info", dispute.id);
    });
  }

  adminMessage(admin: AuthContext, disputeId: string, body: string, internal: boolean) {
    return this.adminAct(admin, disputeId, async (tx, { dispute }) => {
      if (!ACTIVE_DISPUTE.includes(dispute.status)) throw conflict("DISPUTE_CLOSED", "This dispute is closed to new messages");
      await tx.disputeMessage.create({ data: { disputeId: dispute.id, authorUserId: admin.userId, authorRole: "ADMIN", body, internal } });
      await this.audit(tx, admin, internal ? "dispute.internal_note" : "dispute.message", dispute.id);
    });
  }

  adminResolve(admin: AuthContext, disputeId: string, outcome: DisputeOutcome, resolution: string) {
    return this.adminAct(admin, disputeId, async (tx, { dispute, booking }, now) => {
      this.requireAction(dispute.status, "resolve");
      await this.applyOutcome(tx, admin, booking, dispute.previousBookingStatus, outcome, now);
      await this.setStatus(tx, dispute.id, dispute.status, "resolve", {
        outcome,
        resolution,
        resolvedByUserId: admin.userId,
        resolvedAt: now,
      });
      await this.audit(tx, admin, "dispute.resolve", dispute.id, { outcome });
    });
  }

  adminReject(admin: AuthContext, disputeId: string, resolution: string) {
    return this.adminAct(admin, disputeId, async (tx, { dispute, booking }, now) => {
      this.requireAction(dispute.status, "reject");
      await this.applyOutcome(tx, admin, booking, dispute.previousBookingStatus, "RESTORE_BOOKING", now);
      await this.setStatus(tx, dispute.id, dispute.status, "reject", {
        outcome: "RESTORE_BOOKING",
        resolution,
        resolvedByUserId: admin.userId,
        resolvedAt: now,
      });
      await this.audit(tx, admin, "dispute.reject", dispute.id);
    });
  }

  /** The only way a DISPUTED booking leaves DISPUTED; always via the state machine. */
  private async applyOutcome(
    tx: Tx,
    admin: AuthContext,
    booking: Awaited<ReturnType<BookingCore["reload"]>>,
    previous: import("../generated/prisma/client.js").BookingStatus,
    outcome: DisputeOutcome,
    now: Date,
  ) {
    const actor = { userId: admin.userId, role: "ADMIN" as const };
    if (outcome === "MARK_COMPLETED") {
      await this.core.transition(tx, booking, "dispute_mark_completed", actor, {
        data: { completedAt: booking.completedAt ?? now },
        eventType: "dispute.resolved_completed",
      });
    } else if (outcome === "CANCEL_BOOKING") {
      await this.core.transition(tx, booking, "dispute_cancel", actor, {
        data: { cancelledAt: now, cancelledByUserId: admin.userId, cancellationReason: "Cancelled through dispute resolution" },
        eventType: "dispute.resolved_cancelled",
        metadata: { paymentReviewRequired: true },
      });
    } else {
      await this.core.transition(tx, booking, "dispute_restore", actor, {
        eventType: "dispute.restored",
        previousStatus: previous,
      });
    }
  }
}
