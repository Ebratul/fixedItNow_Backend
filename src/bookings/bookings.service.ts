import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import type { BookingStatus, Prisma } from "../generated/prisma/client.js";
import { chatAccess } from "../chat/chat.access.js";
import { NotificationsService, type NewNotification } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";
import { reviewSummary } from "../reviews/review.summary.js";
import { paymentSummary } from "../payments/payment.summary.js";
import { AvailabilityService, lockWorker } from "./availability.service.js";
import {
  BOOKING_TIMEZONE,
  LATE_CANCELLATION_HOURS,
  MAX_OPEN_REQUESTS_PER_CUSTOMER,
  START_EARLY_MINUTES,
  START_WINDOW_AFTER_END_MINUTES,
} from "./booking.config.js";
import { BookingCore, effectiveStatus, type Loaded, type ViewerRole } from "./booking-core.service.js";
import type { CreateBookingInput, ListBookingsQuery } from "./booking.schemas.js";
import { conflict, forbidden, unprocessable, isUniqueViolation } from "./domain-errors.js";
import { addMinutes } from "./time.js";

const GROUP_STATUSES: Record<string, BookingStatus[]> = {
  open: ["REQUESTED", "QUOTED"],
  active: ["CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING"],
  history: ["COMPLETED", "CANCELLED", "DECLINED", "EXPIRED"],
  disputed: ["DISPUTED"],
};

type Tx = Prisma.TransactionClient;
/** Queue an in-app notification; it is stored only AFTER the action has committed (and a failure never undoes it). */
export type Notify = (notice: NewNotification) => void;

const bookingLink = (id: string) => `/bookings/${id}`;

@Injectable()
export class BookingsService {
  constructor(
    private readonly core: BookingCore,
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- create

  /**
   * Create a booking REQUEST. Identity, price, and eligibility come from the
   * server: the browser supplies only the worker id, service, description,
   * place, and time. A request does NOT reserve the slot.
   */
  async create(auth: AuthContext, input: CreateBookingInput, idempotencyKey: string | undefined) {
    const now = this.core.clock.now();
    const worker = await this.prisma.workerProfile.findFirst({
      where: { ...ELIGIBLE_WORKER, id: input.workerId },
      select: {
        id: true,
        userId: true,
        displayName: true,
        serviceAreas: true,
        services: {
          where: { category: { slug: input.categorySlug, isActive: true } },
          select: {
            pricingModel: true,
            basePriceBdt: true,
            pricingNotes: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });
    // Same answer as the public profile for hidden/unknown workers.
    if (!worker) throw unprocessable("WORKER_UNAVAILABLE", "This professional is not accepting bookings");
    if (worker.userId === auth.userId) throw unprocessable("OWN_PROFILE", "You cannot book yourself");
    const service = worker.services[0];
    if (!service) throw unprocessable("SERVICE_NOT_OFFERED", "This professional does not offer that service");
    if (!worker.serviceAreas.includes(input.serviceArea)) {
      throw unprocessable("AREA_NOT_SERVED", `This professional does not serve ${input.serviceArea}`);
    }

    const end = addMinutes(input.startAt, input.durationMinutes);
    // Early, friendly failure. The authoritative check happens at confirmation.
    await this.availability.assertBookable(this.prisma, worker.id, input.startAt, end, { now });

    const created = await this.prisma.$transaction(async (tx) => {
      // Serialise this customer's requests to this worker (duplicate protection).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${auth.userId}:${worker.id}`}, 0))`;

      if (idempotencyKey) {
        const existing = await tx.booking.findUnique({
          where: { customerId_idempotencyKey: { customerId: auth.userId, idempotencyKey } },
          include: { category: { select: { slug: true } } },
        });
        if (existing) {
          const same =
            existing.workerProfileId === worker.id &&
            existing.startAt.getTime() === input.startAt.getTime() &&
            existing.durationMinutes === input.durationMinutes;
          if (!same) throw conflict("IDEMPOTENCY_KEY_REUSED", "That request key was already used for a different booking");
          return { id: existing.id, replay: true };
        }
      }

      const open = await tx.booking.count({
        where: { customerId: auth.userId, status: { in: ["REQUESTED", "QUOTED"] }, startAt: { gt: now } },
      });
      if (open >= MAX_OPEN_REQUESTS_PER_CUSTOMER) {
        throw unprocessable("TOO_MANY_OPEN_REQUESTS", "You have too many open requests. Cancel or wait for some to be answered.");
      }

      const duplicate = await tx.booking.findFirst({
        where: {
          customerId: auth.userId,
          workerProfileId: worker.id,
          status: { in: ["REQUESTED", "QUOTED", "CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING"] },
          startAt: { lt: end },
          endAt: { gt: input.startAt },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw conflict("DUPLICATE_REQUEST", "You already have a booking with this professional at an overlapping time");
      }

      let booking;
      try {
        booking = await tx.booking.create({
          data: {
            customerId: auth.userId,
            workerProfileId: worker.id,
            categoryId: service.category.id,
            description: input.description,
            serviceArea: input.serviceArea,
            serviceAddress: input.serviceAddress,
            startAt: input.startAt,
            endAt: end,
            durationMinutes: input.durationMinutes,
            timezone: BOOKING_TIMEZONE,
            pricingModel: service.pricingModel,
            unitPriceBdt: service.basePriceBdt,
            pricingSnapshot: {
              categoryName: service.category.name,
              workerDisplayName: worker.displayName,
              pricingModel: service.pricingModel,
              basePriceBdt: service.basePriceBdt,
              pricingNotes: service.pricingNotes,
            },
            idempotencyKey: idempotencyKey ?? null,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error) && idempotencyKey) {
          throw conflict("DUPLICATE_REQUEST", "This request was already submitted");
        }
        throw error;
      }
      await this.core.event(tx, booking.id, { userId: auth.userId, role: "CUSTOMER" }, "booking.requested", {
        to: "REQUESTED",
        metadata: { pricingModel: service.pricingModel },
      });
      return { id: booking.id, replay: false };
    });

    // After the commit: a replayed request (same idempotency key) notifies nobody twice.
    if (!created.replay) {
      await this.notifications.notifyBestEffort([
        {
          userId: worker.userId,
          type: "booking.requested",
          title: "New booking request",
          body: `A customer asked for ${service.category.name}. Open the request to accept, decline or send a quote.`,
          link: bookingLink(created.id),
        },
      ]);
    }

    return { ...(await this.detail(auth, created.id)), created: !created.replay };
  }

  // ---------------------------------------------------------------- read

  async list(auth: AuthContext, query: ListBookingsQuery) {
    const now = this.core.clock.now();
    const side: Prisma.BookingWhereInput =
      query.role === "customer" ? { customerId: auth.userId } : { workerProfile: { userId: auth.userId } };

    // Requests whose start time passed are shown as expired (see effectiveStatus).
    const pending = { status: { in: ["REQUESTED", "QUOTED"] as BookingStatus[] } };
    let group: Prisma.BookingWhereInput = {};
    if (query.group === "open") group = { AND: [pending, { startAt: { gt: now } }] };
    else if (query.group === "history") {
      group = { OR: [{ status: { in: GROUP_STATUSES.history } }, { AND: [pending, { startAt: { lte: now } }] }] };
    } else if (query.group !== "all") group = { status: { in: GROUP_STATUSES[query.group] } };

    const where: Prisma.BookingWhereInput = { AND: [side, group] };
    const orderBy: Prisma.BookingOrderByWithRelationInput[] =
      query.group === "active" ? [{ startAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }];

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          category: { select: { slug: true, name: true } },
          workerProfile: { select: { displayName: true } },
          customer: { select: { name: true, customerProfile: { select: { displayName: true } } } },
        },
      }),
    ]);

    return {
      bookings: rows.map((b) => ({
        id: b.id,
        status: effectiveStatus(b, now),
        category: b.category,
        counterpartyName:
          query.role === "customer"
            ? (b.workerProfile.displayName ?? "Professional")
            : (b.customer.customerProfile?.displayName ?? b.customer.name),
        serviceArea: b.serviceArea,
        startAt: b.startAt,
        endAt: b.endAt,
        agreedAmountBdt: b.agreedAmountBdt,
        pricingModel: b.pricingModel,
        createdAt: b.createdAt,
      })),
      role: query.role,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /** Full detail for a participant. Applies lazy expiry first. */
  async detail(auth: AuthContext, bookingId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.core.loadParticipant(tx, auth.userId, bookingId); // authorise before any write
      await this.core.refresh(tx, bookingId);
      const loaded = await this.core.loadParticipant(tx, auth.userId, bookingId);
      return this.compose(tx, loaded);
    });
  }

  async history(auth: AuthContext, bookingId: string) {
    await this.core.loadParticipant(this.prisma, auth.userId, bookingId);
    return { events: await this.events(this.prisma, bookingId) };
  }

  private async events(db: PrismaService | Tx, bookingId: string) {
    const rows = await db.bookingEvent.findMany({
      where: { bookingId },
      // The NEWEST 200, shown oldest-first: a cap must never hide the latest actions.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: { id: true, type: true, actorRole: true, fromStatus: true, toStatus: true, reason: true, createdAt: true },
    });
    return rows.reverse();
  }

  async compose(tx: Tx, { booking, viewer }: Loaded) {
    const now = this.core.clock.now();
    // Sequential on purpose: a transaction owns ONE connection, and issuing
    // concurrent queries on it is deprecated in node-postgres.
    const quotes = await tx.quote.findMany({ where: { bookingId: booking.id }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50 });
    const reschedules = await tx.rescheduleRequest.findMany({ where: { bookingId: booking.id }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50 });
    const dispute = await tx.dispute.findUnique({
      where: { bookingId: booking.id },
      select: { id: true, status: true, category: true, openedByRole: true, resolution: true, outcome: true, resolvedAt: true, createdAt: true },
    });
    const events = await this.events(tx, booking.id);

    const status = effectiveStatus(booking, now);
    const quotePresented = quotes.map((q) => {
      const live = q.status === "PENDING" && q.expiresAt > now;
      return {
        id: q.id,
        status: q.status === "PENDING" && !live ? "EXPIRED" : q.status,
        laborBdt: q.laborBdt,
        materialsBdt: q.materialsBdt,
        otherBdt: q.otherBdt,
        totalBdt: q.totalBdt,
        currency: q.currency,
        description: q.description,
        terms: q.terms,
        estimatedDurationMinutes: q.estimatedDurationMinutes,
        expiresAt: q.expiresAt,
        createdAt: q.createdAt,
        decidedAt: q.decidedAt,
        actions: !live ? [] : viewer === "CUSTOMER" && status === "QUOTED" ? ["accept", "reject"] : viewer === "WORKER" ? ["withdraw"] : [],
      };
    });
    const reschedulePresented = reschedules.map((r) => {
      const live = r.status === "PENDING" && r.expiresAt > now;
      const mine = r.requestedByRole === viewer;
      return {
        id: r.id,
        status: r.status === "PENDING" && !live ? "EXPIRED" : r.status,
        newStartAt: r.newStartAt,
        newEndAt: r.newEndAt,
        previousStartAt: r.previousStartAt,
        previousEndAt: r.previousEndAt,
        reason: r.reason,
        requestedByRole: r.requestedByRole,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        actions: !live ? [] : mine ? ["withdraw"] : ["accept", "reject"],
      };
    });

    const actions = this.core.actionsFor(booking, viewer, now, {
      hasPendingQuote: quotePresented.some((q) => q.actions.length > 0),
      hasPendingReschedule: reschedulePresented.some((r) => r.status === "PENDING"),
      hasDispute: dispute !== null,
    });

    return {
      booking: this.core.present(booking, viewer, now),
      actions,
      quotes: quotePresented,
      rescheduleRequests: reschedulePresented,
      dispute,
      events,
      chat: this.chatView(booking),
      payment: await paymentSummary(tx, booking, viewer),
      review: await reviewSummary(tx, booking, viewer, now),
    };
  }

  /** Whether the booking's private conversation is open to this booking's participants right now. */
  private chatView(booking: Loaded["booking"]) {
    const access = chatAccess(booking, this.core.clock.now());
    return { state: access.state, reason: access.reason };
  }

  // ---------------------------------------------------------------- actions

  /** Run one action as the booking's participant, atomically. */
  async act(
    auth: AuthContext,
    bookingId: string,
    requireViewer: ViewerRole | null,
    work: (tx: Tx, loaded: Loaded, now: Date, notify: Notify) => Promise<void>,
  ) {
    const notices: NewNotification[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      notices.length = 0; // the callback runs again if the transaction is retried
      const queue: Notify = (n) => void notices.push(n);
      const first = await this.core.loadParticipant(tx, auth.userId, bookingId);
      if (requireViewer && first.viewer !== requireViewer) {
        throw forbidden(
          "NOT_ALLOWED",
          requireViewer === "WORKER"
            ? "Only the assigned professional can do this"
            : "Only the customer who made this booking can do this",
        );
      }
      await lockWorker(tx, first.booking.workerProfileId);
      await this.core.refresh(tx, bookingId);
      const loaded = await this.core.loadParticipant(tx, auth.userId, bookingId);
      await work(tx, loaded, this.core.clock.now(), queue);
      return this.compose(tx, await this.core.loadParticipant(tx, auth.userId, bookingId));
    });
    // The action is committed. A notification that cannot be stored must not undo it.
    await this.notifications.notifyBestEffort(notices);
    return result;
  }

  /** Worker accepts a fixed-price / hourly request; confirms the slot. */
  accept(auth: AuthContext, bookingId: string) {
    return this.act(auth, bookingId, "WORKER", async (tx, { booking }, now, notify) => {
      if (booking.pricingModel === "QUOTE") {
        throw unprocessable("QUOTE_REQUIRED", "This service is priced by quote. Send a quote instead.");
      }
      if (booking.status !== "REQUESTED") {
        throw conflict("INVALID_TRANSITION", `Cannot accept a booking that is ${effectiveStatus(booking, now)}`);
      }
      this.core.assertWorkerStillEligible(booking);
      await this.availability.assertBookable(tx, booking.workerProfileId, booking.startAt, booking.endAt, {
        now,
        minLeadMinutes: 0,
        excludeBookingId: booking.id,
      });
      // Price from the stored snapshot: FIXED = rate, HOURLY = rate x duration.
      const unit = booking.unitPriceBdt ?? 0;
      // A booking is FIXED or HOURLY and must carry a positive snapshot price; never confirm one at 0 taka.
      if (!(unit > 0)) {
        throw conflict("PRICE_UNAVAILABLE", "This booking has no valid price, so it cannot be accepted");
      }
      const amount = booking.pricingModel === "HOURLY" ? Math.round((unit * booking.durationMinutes) / 60) : unit;
      await this.core.transition(tx, booking, "accept", { userId: auth.userId, role: "WORKER" }, {
        data: { agreedAmountBdt: amount, confirmedAt: now },
        eventType: "booking.accepted",
        metadata: { agreedAmountBdt: amount, pricingModel: booking.pricingModel },
      });
      notify({
        userId: booking.customerId,
        type: "booking.accepted",
        title: "Your booking was accepted",
        body: `${booking.workerProfile.displayName ?? "The professional"} accepted your ${booking.category.name} request. The time is reserved and you can now message them.`,
        link: `${bookingLink(booking.id)}?chat=1`,
      });
    });
  }

  decline(auth: AuthContext, bookingId: string, reason?: string) {
    return this.act(auth, bookingId, "WORKER", async (tx, { booking }, now, notify) => {
      await this.core.transition(tx, booking, "decline", { userId: auth.userId, role: "WORKER" }, {
        eventType: "booking.declined",
        reason,
      });
      await this.closeOpenProposals(tx, booking.id, now);
      notify({
        userId: booking.customerId,
        type: "booking.declined",
        title: "Your booking request was declined",
        body: `${booking.workerProfile.displayName ?? "The professional"} could not take your ${booking.category.name} request. No time was reserved; you can choose another professional.`,
        link: bookingLink(booking.id),
      });
    });
  }

  /**
   * Cancellation policy (no fees or refunds are implied; payments do not exist yet):
   *  - customer: before confirmation (reason optional) or after (reason required)
   *  - worker:   only after confirmation (reason required); before it, use `decline`
   *  - nobody:   once the job has started (use a dispute) or the booking is closed
   * Immediate, unilateral, and recorded with actor, reason and time. Cancelling a
   * confirmed booking releases its slot (CANCELLED does not reserve) and is flagged
   * for payment review in Step 6.
   */
  cancel(auth: AuthContext, bookingId: string, reason?: string) {
    return this.act(auth, bookingId, null, async (tx, { booking, viewer }, now, notify) => {
      const role = viewer === "CUSTOMER" ? "CUSTOMER" : "WORKER";
      const wasConfirmed = booking.status === "CONFIRMED";
      if (role === "WORKER" && !wasConfirmed) {
        throw conflict("INVALID_TRANSITION", "Use decline for requests that are not confirmed yet");
      }
      if (wasConfirmed && !reason) {
        throw unprocessable("REASON_REQUIRED", "Please give a reason (at least 5 characters) for cancelling a confirmed booking");
      }
      const late = wasConfirmed && booking.startAt.getTime() - now.getTime() < LATE_CANCELLATION_HOURS * 3_600_000;
      await this.core.transition(tx, booking, "cancel", { userId: auth.userId, role }, {
        data: { cancelledAt: now, cancelledByUserId: auth.userId, cancellationReason: reason ?? null },
        eventType: "booking.cancelled",
        reason,
        metadata: {
          wasConfirmed,
          lateCancellation: late,
          // Step 6 reads this to decide whether a payment needs review. No money has moved.
          paymentReviewRequired: wasConfirmed,
        },
      });
      await this.closeOpenProposals(tx, booking.id, now);
      notify({
        userId: viewer === "CUSTOMER" ? booking.workerProfile.userId : booking.customerId,
        type: "booking.cancelled",
        title: "A booking was cancelled",
        body: `${viewer === "CUSTOMER" ? "The customer" : (booking.workerProfile.displayName ?? "The professional")} cancelled the ${booking.category.name} booking.`,
        link: bookingLink(booking.id),
      });
    });
  }

  /**
   * The professional reports that they have arrived. This is a self-reported milestone, not a verified
   * location: nothing here reads a GPS position, and the UI says so. The status stays CONFIRMED (the slot
   * stays reserved, the customer can still cancel); `arrivedAt` is stamped once, atomically, and the
   * customer is notified. A second report is a 409, not a second notification.
   */
  arrive(auth: AuthContext, bookingId: string) {
    return this.act(auth, bookingId, "WORKER", async (tx, { booking }, now, notify) => {
      if (booking.status === "CONFIRMED") {
        if (booking.arrivedAt) throw conflict("ALREADY_ARRIVED", "You already reported arriving for this booking");
        this.assertInStartWindow(booking, now, "report arriving");
      }
      await this.core.transition(tx, booking, "arrive", { userId: auth.userId, role: "WORKER" }, {
        // The status condition inside `transition` plus the per-worker lock held by `act` make this a single winner.
        data: { arrivedAt: now },
        eventType: "booking.arrived",
        metadata: { selfReported: true },
      });
      await tx.rescheduleRequest.updateMany({
        where: { bookingId: booking.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
      notify({
        userId: booking.customerId,
        type: "booking.arrived",
        title: "Your professional has arrived",
        body: `${booking.workerProfile.displayName ?? "The professional"} reports arriving for your ${booking.category.name} booking.`,
        link: bookingLink(booking.id),
      });
    });
  }

  private assertInStartWindow(booking: { startAt: Date; endAt: Date }, now: Date, verb: string) {
    if (now < addMinutes(booking.startAt, -START_EARLY_MINUTES)) {
      throw unprocessable("TOO_EARLY", `You can ${verb} up to ${START_EARLY_MINUTES} minutes before the scheduled time`);
    }
    if (now > addMinutes(booking.endAt, START_WINDOW_AFTER_END_MINUTES)) {
      throw unprocessable("START_WINDOW_PASSED", `The window to ${verb} has passed`);
    }
  }

  start(auth: AuthContext, bookingId: string) {
    return this.act(auth, bookingId, "WORKER", async (tx, { booking }, now) => {
      if (booking.status === "CONFIRMED") this.assertInStartWindow(booking, now, "start a job");
      await this.core.transition(tx, booking, "start", { userId: auth.userId, role: "WORKER" }, {
        data: { startedAt: now },
        eventType: "booking.started",
      });
      await tx.rescheduleRequest.updateMany({
        where: { bookingId: booking.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
    });
  }

  /**
   * The CUSTOMER says the work is done, from any time after confirmation (typically earlier than scheduled, when the
   * professional's arrival/start window has not opened). It does exactly what the professional's report does: the booking
   * becomes COMPLETION_PENDING (payment due). It does not complete or pay anything, and the professional can still dispute it.
   */
  markFinished(auth: AuthContext, bookingId: string) {
    return this.act(auth, bookingId, "CUSTOMER", async (tx, { booking }, now, notify) => {
      await this.core.transition(tx, booking, "customer_finish", { userId: auth.userId, role: "CUSTOMER" }, {
        data: { completionRequestedAt: now },
        eventType: "booking.completion_requested",
        metadata: { byCustomer: true, agreedAmountBdt: booking.agreedAmountBdt ?? 0 },
      });
      await tx.rescheduleRequest.updateMany({
        where: { bookingId: booking.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
      notify({
        userId: booking.workerProfile.userId,
        type: "booking.finished_by_customer",
        title: "The customer marked the job finished",
        body: `The customer says your ${booking.category.name} job is done and will pay ৳${booking.agreedAmountBdt ?? 0}. If that is wrong, report a problem on the booking.`,
        link: bookingLink(booking.id),
      });
    });
  }

  /**
   * The professional reports the job finished: the booking moves to COMPLETION_PENDING, which means
   * "work finished, payment due". It does NOT complete or pay the booking; only a verified payment does
   * (PaymentsService). The customer is told what they owe, from the stored agreed amount.
   */
  complete(auth: AuthContext, bookingId: string) {
    return this.act(auth, bookingId, "WORKER", async (tx, { booking }, now, notify) => {
      await this.core.transition(tx, booking, "complete", { userId: auth.userId, role: "WORKER" }, {
        data: { completionRequestedAt: now },
        eventType: "booking.completion_requested",
        metadata: { agreedAmountBdt: booking.agreedAmountBdt ?? 0 },
      });
      notify({
        userId: booking.customerId,
        type: "booking.payment_due",
        title: "Work finished: payment is due",
        body: `${booking.workerProfile.displayName ?? "The professional"} marked your ${booking.category.name} job finished.${booking.agreedAmountBdt ? ` Pay ৳${booking.agreedAmountBdt} to complete the booking.` : ""}`,
        link: bookingLink(booking.id),
      });
    });
  }

  /** Pending quotes and reschedule requests die with the booking's open phase. */
  async closeOpenProposals(tx: Tx, bookingId: string, now: Date) {
    await tx.quote.updateMany({ where: { bookingId, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: now } });
    await tx.rescheduleRequest.updateMany({
      where: { bookingId, status: "PENDING" },
      data: { status: "WITHDRAWN", decidedAt: now },
    });
  }
}

