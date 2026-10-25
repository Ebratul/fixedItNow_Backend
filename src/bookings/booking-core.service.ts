import { Injectable, NotFoundException } from "@nestjs/common";
import type { ActorRole, BookingStatus, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { isListable } from "../workers/eligibility.js";
import {
  DISPUTE_WINDOW_DAYS,
  MIN_LEAD_MINUTES,
  START_EARLY_MINUTES,
  START_WINDOW_AFTER_END_MINUTES,
} from "./booking.config.js";
import {
  assertTransition,
  InvalidTransitionError,
  isReserving,
  targetOf,
  type BookingAction,
} from "./booking.state.js";
import { Clock } from "./clock.js";
import { bookingNotFound, conflict, isExclusionViolation } from "./domain-errors.js";
import { addMinutes } from "./time.js";

type Db = PrismaService | Prisma.TransactionClient;

export const bookingInclude = {
  workerProfile: {
    select: {
      id: true,
      userId: true,
      displayName: true,
      slug: true,
      onboardingStatus: true,
      verificationStatus: true,
      publishedAt: true,
      suspendedAt: true,
    },
  },
  customer: { select: { id: true, name: true, customerProfile: { select: { displayName: true } } } },
  category: { select: { slug: true, name: true } },
} as const satisfies Prisma.BookingInclude;

export type BookingRow = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;
export type ViewerRole = "CUSTOMER" | "WORKER";
export type Actor = { userId: string | null; role: ActorRole };

export type Loaded = { booking: BookingRow; viewer: ViewerRole };

/** Booking statuses after which the worker may see the customer's full address. */
const ADDRESS_VISIBLE: BookingStatus[] = [
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETION_PENDING",
  "COMPLETED",
  "DISPUTED",
];

export function customerName(b: BookingRow): string {
  return b.customer.customerProfile?.displayName ?? b.customer.name;
}

/** A request nobody confirmed before its start time is expired (applied lazily). */
export function effectiveStatus(b: Pick<BookingRow, "status" | "startAt">, now: Date): BookingStatus {
  return (b.status === "REQUESTED" || b.status === "QUOTED") && b.startAt <= now ? "EXPIRED" : b.status;
}

@Injectable()
export class BookingCore {
  constructor(
    readonly prisma: PrismaService,
    readonly clock: Clock,
  ) {}

  /**
   * Load a booking for a participant. Anyone else (including other customers,
   * other workers, and non-existent ids) gets the same 404, so ids cannot be
   * probed for existence.
   */
  async loadParticipant(db: Db, userId: string, bookingId: string): Promise<Loaded> {
    const booking = await db.booking.findUnique({ where: { id: bookingId }, include: bookingInclude });
    if (!booking) throw bookingNotFound();
    if (booking.customerId === userId) return { booking, viewer: "CUSTOMER" };
    if (booking.workerProfile.userId === userId) return { booking, viewer: "WORKER" };
    throw bookingNotFound();
  }

  async reload(db: Db, bookingId: string): Promise<BookingRow> {
    const booking = await db.booking.findUnique({ where: { id: bookingId }, include: bookingInclude });
    if (!booking) throw new NotFoundException("Booking not found");
    return booking;
  }

  /**
   * Lazy expiry (there is no background scheduler yet). Idempotent; call at the
   * start of any write and when a detail page is opened:
   *  - pending quotes past their expiry become EXPIRED (QUOTED -> REQUESTED when none left)
   *  - pending reschedule requests past their expiry become EXPIRED
   *  - REQUESTED/QUOTED bookings whose start has passed become EXPIRED
   */
  async refresh(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
    const now = this.clock.now();
    const expiredQuotes = await tx.quote.updateMany({
      where: { bookingId, status: "PENDING", expiresAt: { lte: now } },
      data: { status: "EXPIRED", decidedAt: now },
    });
    if (expiredQuotes.count > 0) {
      const reverted = await tx.booking.updateMany({
        where: { id: bookingId, status: "QUOTED", quotes: { none: { status: "PENDING" } } },
        data: { status: "REQUESTED" },
      });
      if (reverted.count > 0) {
        await this.event(tx, bookingId, { userId: null, role: "SYSTEM" }, "quote.expired", {
          from: "QUOTED",
          to: "REQUESTED",
        });
      }
    }
    await tx.rescheduleRequest.updateMany({
      where: { bookingId, status: "PENDING", expiresAt: { lte: now } },
      data: { status: "EXPIRED", decidedAt: now },
    });
    const due = await tx.booking.findFirst({
      where: { id: bookingId, status: { in: ["REQUESTED", "QUOTED"] }, startAt: { lte: now } },
      select: { id: true, status: true },
    });
    if (due) {
      const changed = await tx.booking.updateMany({
        where: { id: bookingId, status: due.status },
        data: { status: "EXPIRED" },
      });
      if (changed.count > 0) {
        await tx.quote.updateMany({
          where: { bookingId, status: "PENDING" },
          data: { status: "EXPIRED", decidedAt: now },
        });
        await this.event(tx, bookingId, { userId: null, role: "SYSTEM" }, "booking.expired", {
          from: due.status,
          to: "EXPIRED",
          reason: "No confirmation before the requested start time",
        });
      }
    }
  }

  /** Append to the booking history/audit trail. */
  async event(
    tx: Prisma.TransactionClient,
    bookingId: string,
    actor: Actor,
    type: string,
    details: {
      from?: BookingStatus;
      to?: BookingStatus;
      reason?: string | null;
      metadata?: Prisma.InputJsonValue;
    } = {},
  ) {
    await tx.bookingEvent.create({
      data: {
        bookingId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        type,
        fromStatus: details.from ?? null,
        toStatus: details.to ?? null,
        reason: details.reason ?? null,
        metadata: details.metadata,
      },
    });
  }

  /**
   * Perform a state-machine transition atomically.
   *  1. the action must be legal for this actor from the stored status
   *  2. the UPDATE is conditional on the status we read (`status = from`), so a
   *     concurrent change makes it affect 0 rows => 409 instead of a lost update
   *  3. the DB exclusion constraint rejects a slot clash for reserving statuses
   *  4. a history event is written in the same transaction
   * Throw straight away on failure: the surrounding transaction rolls back.
   */
  async transition(
    tx: Prisma.TransactionClient,
    booking: Pick<BookingRow, "id" | "status">,
    action: BookingAction,
    actor: Actor,
    options: {
      data?: Prisma.BookingUncheckedUpdateManyInput;
      eventType: string;
      reason?: string | null;
      metadata?: Prisma.InputJsonValue;
      previousStatus?: BookingStatus;
    },
  ): Promise<BookingStatus> {
    try {
      assertTransition(action, actor.role, booking.status);
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        throw conflict("INVALID_TRANSITION", error.message);
      }
      throw error;
    }
    const to = targetOf(action, options.previousStatus);
    let count: number;
    try {
      ({ count } = await tx.booking.updateMany({
        where: { id: booking.id, status: booking.status },
        data: { ...options.data, status: to },
      }));
    } catch (error) {
      if (isExclusionViolation(error) && isReserving(to)) {
        throw conflict("SLOT_UNAVAILABLE", "That time slot is no longer available");
      }
      throw error;
    }
    if (count === 0) {
      throw conflict("STALE_BOOKING", "This booking just changed. Refresh the page and try again.");
    }
    await this.event(tx, booking.id, actor, options.eventType, {
      from: booking.status,
      to,
      reason: options.reason,
      metadata: options.metadata,
    });
    return to;
  }

  /** The worker must still be publicly listed to take on NEW commitments. */
  assertWorkerStillEligible(booking: BookingRow) {
    if (!isListable(booking.workerProfile)) {
      throw conflict("WORKER_UNAVAILABLE", "This professional is not accepting bookings right now");
    }
  }

  // ---------------------------------------------------------------- presentation

  cancelledByRole(b: BookingRow): ActorRole | null {
    if (!b.cancelledByUserId) return null;
    if (b.cancelledByUserId === b.customerId) return "CUSTOMER";
    if (b.cancelledByUserId === b.workerProfile.userId) return "WORKER";
    return "ADMIN";
  }

  /** Booking as one participant is allowed to see it. */
  present(b: BookingRow, viewer: ViewerRole, now: Date) {
    const showAddress = viewer === "CUSTOMER" || ADDRESS_VISIBLE.includes(b.status);
    return {
      id: b.id,
      status: effectiveStatus(b, now),
      viewerRole: viewer,
      category: b.category,
      description: b.description,
      serviceArea: b.serviceArea,
      // Workers only see the street address once the booking is confirmed.
      serviceAddress: showAddress ? b.serviceAddress : null,
      startAt: b.startAt,
      endAt: b.endAt,
      durationMinutes: b.durationMinutes,
      timezone: b.timezone,
      worker: {
        displayName: b.workerProfile.displayName ?? "Professional",
        slug: isListable(b.workerProfile) ? b.workerProfile.slug : null,
      },
      customer: viewer === "WORKER" ? { name: customerName(b) } : undefined,
      pricing: {
        model: b.pricingModel,
        unitPriceBdt: b.unitPriceBdt,
        agreedAmountBdt: b.agreedAmountBdt,
        currency: b.currency,
      },
      confirmedAt: b.confirmedAt,
      // From this moment the professional may report arriving / start the job (the server enforces it; the UI explains it).
      startWindowOpensAt: addMinutes(b.startAt, -START_EARLY_MINUTES),
      // The professional's own report that they arrived. NOT a verified location: nothing here is GPS-checked.
      arrivedAt: b.arrivedAt,
      startedAt: b.startedAt,
      completionRequestedAt: b.completionRequestedAt,
      completedAt: b.completedAt,
      cancellation: b.cancelledAt
        ? { at: b.cancelledAt, reason: b.cancellationReason, by: this.cancelledByRole(b) }
        : null,
      createdAt: b.createdAt,
    };
  }

  /**
   * The actions the viewer may take RIGHT NOW. The UI renders buttons from this
   * list only; every action is re-validated server-side when invoked.
   */
  actionsFor(
    b: BookingRow,
    viewer: ViewerRole,
    now: Date,
    ctx: { hasPendingQuote: boolean; hasPendingReschedule: boolean; hasDispute: boolean },
  ): string[] {
    const status = effectiveStatus(b, now);
    const out: string[] = [];
    const isWorker = viewer === "WORKER";
    const isCustomer = viewer === "CUSTOMER";
    const startWindowOpens = addMinutes(b.startAt, -START_EARLY_MINUTES);

    if (isWorker && status === "REQUESTED" && b.pricingModel !== "QUOTE") out.push("accept");
    if (isWorker && (status === "REQUESTED" || status === "QUOTED")) out.push("decline");
    if (isWorker && (status === "REQUESTED" || status === "QUOTED") && b.pricingModel === "QUOTE") out.push("quote");
    if (isCustomer && ["REQUESTED", "QUOTED", "CONFIRMED"].includes(status)) out.push("cancel");
    if (isWorker && status === "CONFIRMED") out.push("cancel");
    // Arrival and start share a window: from START_EARLY_MINUTES before the start until 24 h after the end.
    const inStartWindow = now >= startWindowOpens && now <= addMinutes(b.endAt, START_WINDOW_AFTER_END_MINUTES);
    if (isWorker && status === "CONFIRMED" && inStartWindow && b.arrivedAt === null) out.push("arrive");
    if (isWorker && status === "CONFIRMED" && now >= startWindowOpens) out.push("start");
    if (isWorker && status === "IN_PROGRESS") out.push("complete");
    if (isCustomer && (status === "CONFIRMED" || status === "IN_PROGRESS")) out.push("mark_finished");
    // Payment completes the booking (see PaymentsService); there is no "confirm completion" action.
    if (status === "CONFIRMED" && b.arrivedAt === null && !ctx.hasPendingReschedule && b.startAt > addMinutes(now, MIN_LEAD_MINUTES)) {
      out.push("reschedule");
    }
    if (!ctx.hasDispute && this.canOpenDispute(b, status, now)) out.push("open_dispute");
    return out;
  }

  canOpenDispute(b: Pick<BookingRow, "startAt" | "completedAt">, status: BookingStatus, now: Date): boolean {
    if (status === "IN_PROGRESS" || status === "COMPLETION_PENDING") return true;
    // A confirmed job whose start time has passed: a possible no-show.
    if (status === "CONFIRMED") return b.startAt <= now;
    if (status === "COMPLETED" && b.completedAt) {
      return now.getTime() - b.completedAt.getTime() <= DISPUTE_WINDOW_DAYS * 86_400_000;
    }
    return false;
  }
}
