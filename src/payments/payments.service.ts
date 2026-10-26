import { BadGatewayException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { bookingNotFound, conflict, isUniqueViolation, unprocessable } from "../bookings/domain-errors.js";
import { BookingCore } from "../bookings/booking-core.service.js";
import { Clock } from "../bookings/clock.js";
import { ENV, type Env } from "../config/env.js";
import type { Payment, PaymentReviewReason, PaymentStatus, Prisma } from "../generated/prisma/client.js";
import { NotificationsService, type NewNotification } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  CURRENCY,
  INITIATED_ABANDON_MINUTES,
  MAX_ATTEMPTS_PER_BOOKING_PER_HOUR,
  MAX_RECONCILE_BATCH,
  OPEN_PAYMENT_STATUSES,
  PAID_PAYMENT_STATUSES,
  PAYABLE_BOOKING_STATUSES,
  PENDING_ABANDON_MINUTES,
  REVERIFY_MIN_SECONDS,
} from "./payment.config.js";
import { changeStatus, lockBooking, lockPayment, newReference, recordEvent, SYSTEM, type Actor, type Tx } from "./payment.db.js";
import type { AdminPaymentsQuery } from "./payment.schemas.js";
import { presentPayment } from "./payment.view.js";
import type { PaymentProviderAdapter, ProviderId, Verification, VerifyContext } from "./providers/payment-provider.js";
import { PaymentProviders } from "./providers/providers.service.js";

const minutes = (n: number) => n * 60_000;

export type ApplyOptions = {
  actor: Actor;
  /** Where the verification came from: callback / ipn / status / reconcile. */
  source: string;
  /** The provider's one-shot execute step ran (bKash): a still-open result then means FAILED. */
  executed?: boolean;
  /** An unpaid, old attempt may be closed as EXPIRED. */
  expireIfStale?: boolean;
  /** The browser/IPN CLAIMED a non-payment; honoured only if the provider does not say paid. */
  claim?: "failed" | "cancelled";
};

const isOpen = (status: PaymentStatus) => OPEN_PAYMENT_STATUSES.includes(status);
const isPaid = (status: PaymentStatus) => PAID_PAYMENT_STATUSES.includes(status);

export function isAllowedCheckoutUrl(raw: string, suffixes: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && suffixes.some((s) => url.hostname.endsWith(s));
  } catch {
    return false;
  }
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviders,
    private readonly clock: Clock,
    private readonly core: BookingCore,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Provider-facing URLs. Built from configuration and the opaque reference only. */
  private publicApi(path: string) {
    return `${new URL(this.env.BETTER_AUTH_URL).origin}/api/v1/payments/${path}`;
  }

  /** Where browsers land after the provider. The page asks the backend for the real status. */
  returnUrl(reference: string) {
    return `${this.env.frontendOrigin}/payments/${reference}?returned=1`;
  }

  listProviders() {
    return { providers: this.providers.describe() };
  }

  // ================================================================ initiate

  /**
   * Start a payment for the booking's agreed amount. The browser supplies only
   * the provider choice: the amount, currency, customer and eligibility all
   * come from the database.
   */
  async initiate(auth: AuthContext, bookingId: string, provider: ProviderId, idempotencyKey: string | undefined) {
    // A demo account only ever pays with the simulation (and nobody else can): see PaymentProviders.get.
    if (auth.demo && provider !== "DEMO") {
      throw unprocessable("DEMO_SIMULATED_ONLY", "In the demo, payments are simulated. Choose “Simulated payment”.");
    }
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw unprocessable("PROVIDER_UNAVAILABLE", "That payment method is not available right now. Please choose another one.");
    }
    const now = this.clock.now();

    const reserved = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          customerId: true,
          status: true,
          agreedAmountBdt: true,
          currency: true,
          category: { select: { name: true } },
        },
      });
      // Not yours (or not real): the same 404 either way.
      if (!booking || booking.customerId !== auth.userId) throw bookingNotFound();

      if (idempotencyKey) {
        const existing = await tx.payment.findUnique({
          where: { customerId_idempotencyKey: { customerId: auth.userId, idempotencyKey } },
        });
        if (existing) {
          if (existing.bookingId !== bookingId || existing.provider !== provider) {
            throw conflict("IDEMPOTENCY_KEY_REUSED", "That request key was already used for a different payment");
          }
          return { payment: existing, replay: true as const, bookingName: booking.category.name };
        }
      }

      const paid = await tx.payment.findFirst({ where: { bookingId, status: { in: [...PAID_PAYMENT_STATUSES] } }, select: { id: true } });
      if (paid) throw conflict("ALREADY_PAID", "This booking has already been paid");
      const review = await tx.payment.findFirst({ where: { bookingId, status: "REQUIRES_REVIEW" }, select: { id: true } });
      if (review) {
        throw conflict("PAYMENT_UNDER_REVIEW", "A payment for this booking is being reviewed. Please contact support instead of paying again.");
      }
      const open = await tx.payment.findFirst({ where: { bookingId, status: { in: [...OPEN_PAYMENT_STATUSES] } } });
      if (open) {
        // A row that never reached the provider (crash between steps) can be closed safely:
        // no checkout URL was ever issued for it.
        const stale = open.status === "PENDING" && now.getTime() - open.createdAt.getTime() > minutes(PENDING_ABANDON_MINUTES);
        if (!stale) {
          throw conflict("PAYMENT_IN_PROGRESS", "A payment for this booking is already in progress. Check its status instead of starting another.");
        }
        await lockPayment(tx, open.id);
        await changeStatus(tx, open, "EXPIRED", SYSTEM, { type: "payment.expired", metadata: { reason: "never_reached_provider" } }, { failureCode: "ABANDONED" });
      }

      if (!PAYABLE_BOOKING_STATUSES.includes(booking.status)) {
        throw unprocessable("BOOKING_NOT_PAYABLE", "This booking cannot be paid right now. It must be confirmed and not cancelled or disputed.");
      }
      const amount = booking.agreedAmountBdt;
      if (amount === null || amount <= 0) throw unprocessable("NO_AGREED_AMOUNT", "There is no agreed price to pay yet");
      if (booking.currency !== CURRENCY) throw unprocessable("UNSUPPORTED_CURRENCY", "Only BDT payments are supported");
      const { min, max } = adapter.amountLimitsBdt;
      if (amount < min || amount > max) {
        throw unprocessable("AMOUNT_OUT_OF_RANGE", `${adapter.label} accepts payments from ৳${min} to ৳${max}. Please choose another method.`);
      }
      const recent = await tx.payment.count({ where: { bookingId, createdAt: { gt: new Date(now.getTime() - minutes(60)) } } });
      if (recent >= MAX_ATTEMPTS_PER_BOOKING_PER_HOUR) {
        throw unprocessable("TOO_MANY_ATTEMPTS", "Too many payment attempts for this booking. Please wait a while before trying again.");
      }

      let payment: Payment;
      try {
        payment = await tx.payment.create({
          data: {
            reference: newReference("FIN"),
            bookingId,
            customerId: auth.userId,
            provider,
            isLive: adapter.isLive,
            status: "PENDING",
            amountBdt: amount,
            currency: CURRENCY,
            idempotencyKey: idempotencyKey ?? null,
            createdAt: now,
          },
        });
      } catch (error) {
        // The partial unique index: two requests raced past the checks above.
        if (isUniqueViolation(error)) {
          throw conflict("PAYMENT_IN_PROGRESS", "A payment for this booking is already in progress.");
        }
        throw error;
      }
      await recordEvent(tx, payment.id, { userId: auth.userId, role: "CUSTOMER" }, {
        type: "payment.created",
        to: "PENDING",
        metadata: { provider, amountBdt: amount, mode: adapter.isLive ? "live" : "sandbox" },
      });
      return { payment, replay: false as const, bookingName: booking.category.name };
    });

    if (reserved.replay) {
      const p = reserved.payment;
      return { payment: presentPayment(p), checkoutUrl: p.status === "INITIATED" ? p.checkoutUrl : null, created: false };
    }

    // The provider is called OUTSIDE the transaction (no locks held over the network).
    const { payment } = reserved;
    const reference = payment.reference;
    let result;
    try {
      result = await adapter.initiate({
        reference,
        amountBdt: payment.amountBdt,
        urls: this.urlsFor(adapter, reference),
        customer: { name: auth.name, email: auth.email },
        productName: reserved.bookingName,
      });
    } catch {
      result = { kind: "unreachable" as const, code: "ERROR" };
    }
    // The simulated provider's checkout is this web app's own page; every real provider's URL must be on its own hosts.
    if (result.kind === "ok" && adapter.id !== "DEMO" && !isAllowedCheckoutUrl(result.checkoutUrl, adapter.checkoutHostSuffixes)) {
      result = { kind: "rejected" as const, code: "BAD_CHECKOUT_URL" };
    }

    const actor: Actor = { userId: auth.userId, role: "CUSTOMER" };
    const final = await this.prisma.$transaction(async (tx) => {
      await lockPayment(tx, payment.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (current.status !== "PENDING") return current; // someone else already moved it
      if (result.kind === "ok") {
        await changeStatus(tx, current, "INITIATED", actor, { type: "payment.initiated", metadata: { provider } }, {
          providerPaymentId: result.providerPaymentId,
          checkoutUrl: result.checkoutUrl,
          initiatedAt: this.clock.now(),
        });
      } else {
        // No session/URL was issued, so no charge is possible: closing the attempt is safe
        // (this is the one place a timeout is allowed to mean "failed").
        await changeStatus(tx, current, "FAILED", actor, {
          type: "payment.failed",
          metadata: { stage: "initiation", outcome: result.kind, code: result.code },
        }, { failureCode: `INIT_${result.kind.toUpperCase()}` });
      }
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });

    if (final.status !== "INITIATED") {
      throw new BadGatewayException({
        statusCode: 502,
        error: "Bad Gateway",
        code: "PROVIDER_ERROR",
        message: `We couldn't start the payment with ${adapter.label}. Nothing was charged. Please try again in a moment.`,
      });
    }
    return { payment: presentPayment(final), checkoutUrl: final.checkoutUrl, created: true };
  }

  /**
   * The simulated checkout (demo accounts only). The customer picks how the SIMULATED payment ends; the result is applied
   * through applyVerification, the same state machine and booking gate as a real payment, with a verification built
   * entirely from the stored attempt (never from the request). It can only touch a DEMO-provider payment of the caller's
   * own, which only exists in the demo realm, so it can never settle a real booking or payment.
   */
  async simulateDemoOutcome(auth: AuthContext, reference: string, outcome: "success" | "failed" | "cancelled") {
    if (!auth.demo) throw new NotFoundException("Payment not found");
    const p = await this.prisma.payment.findUnique({ where: { reference } });
    if (!p || p.customerId !== auth.userId || p.provider !== "DEMO") throw new NotFoundException("Payment not found");
    if (p.status !== "INITIATED" && p.status !== "PROCESSING") {
      throw conflict("NOT_AWAITING_OUTCOME", "This simulated payment is not waiting for an outcome.");
    }
    const verification: Verification =
      outcome === "success"
        ? {
            kind: "completed",
            reference: p.reference,
            providerPaymentId: p.providerPaymentId,
            providerTransactionId: `DEMO-${p.reference}`,
            providerValidationId: null,
            amountPoisha: p.amountBdt * 100,
            currency: p.currency,
            riskFlagged: false,
          }
        : { kind: "not_completed", state: outcome };
    await this.applyVerification(p.id, verification, { actor: { userId: auth.userId, role: "CUSTOMER" }, source: "demo_simulation" });
    return this.getForCustomer(auth, reference);
  }

  private urlsFor(adapter: PaymentProviderAdapter, reference: string) {
    return { callback: this.publicApi(`callbacks/${adapter.id.toLowerCase()}/${reference}`) };
  }

  // ================================================================ read (customer)

  /** The authoritative status. Refreshes an unresolved attempt from the provider first. */
  async getForCustomer(auth: AuthContext, reference: string) {
    const found = await this.prisma.payment.findUnique({ where: { reference }, select: { id: true, customerId: true, status: true } });
    if (!found || found.customerId !== auth.userId) throw new NotFoundException("Payment not found");
    if (isOpen(found.status)) await this.reverify(found.id, { actor: SYSTEM, source: "status" });
    return this.detail(found.id);
  }

  private async detail(paymentId: string) {
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        refunds: { orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 20 },
        events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100 },
        booking: { select: { id: true, status: true, category: { select: { name: true } }, workerProfile: { select: { displayName: true } } } },
      },
    });
    return {
      payment: {
        ...presentPayment(p, { refunds: p.refunds, events: p.events }),
        booking: {
          id: p.booking.id,
          status: p.booking.status,
          serviceName: p.booking.category.name,
          workerName: p.booking.workerProfile.displayName ?? "Professional",
        },
      },
    };
  }

  async listForCustomer(auth: AuthContext, page: number, pageSize: number) {
    const where = { customerId: auth.userId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { booking: { select: { category: { select: { name: true } }, workerProfile: { select: { displayName: true } } } } },
      }),
    ]);
    return {
      payments: rows.map((p) => ({
        ...presentPayment(p),
        booking: { serviceName: p.booking.category.name, workerName: p.booking.workerProfile.displayName ?? "Professional" },
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ================================================================ verification core

  private ctxFor(p: Payment): VerifyContext {
    return {
      reference: p.reference,
      providerPaymentId: p.providerPaymentId,
      providerValidationId: p.providerValidationId,
      amountBdt: p.amountBdt,
    };
  }

  /**
   * Ask the provider about an unresolved attempt and apply the answer. Never
   * throws for provider problems: an inconclusive answer leaves the state alone.
   * Throttled per payment so a polling browser cannot hammer the provider.
   */
  async reverify(paymentId: string, opts: { actor: Actor; source: string; force?: boolean }): Promise<void> {
    const now = this.clock.now();
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p) return;
    const reopenable = p.status === "FAILED" || p.status === "CANCELLED" || p.status === "EXPIRED";
    if (!isOpen(p.status) && !(opts.force && reopenable)) return;
    const adapter = this.providers.get(p.provider);
    if (!adapter) return; // provider no longer configured: nothing to ask

    // Claim the lookup. A concurrent poller that loses the race simply reads the current state.
    const cutoff = new Date(now.getTime() - REVERIFY_MIN_SECONDS * 1000);
    const claim = await this.prisma.payment.updateMany({
      where: {
        id: p.id,
        status: p.status,
        ...(opts.force ? {} : { OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: cutoff } }] }),
      },
      data: { lastVerifiedAt: now, verificationAttempts: { increment: 1 } },
    });
    if (claim.count === 0) return;

    const age = now.getTime() - (p.initiatedAt ?? p.createdAt).getTime();
    const abandonAfter = p.status === "PENDING" ? PENDING_ABANDON_MINUTES : INITIATED_ABANDON_MINUTES;
    const expireIfStale = (p.status === "PENDING" || p.status === "INITIATED") && age > minutes(abandonAfter);

    // bKash: the customer approved (callback arrived) but EXECUTE has not run yet.
    const needsExecute = p.status === "PROCESSING" && p.callbackReceivedAt !== null && p.executeStartedAt === null;
    let verification: Verification;
    let executed = false;
    try {
      if (needsExecute && adapter.completeAfterApproval && (await this.claimExecute(p.id))) {
        const res = await adapter.completeAfterApproval(this.ctxFor(p));
        verification = res.verification;
        executed = res.executed;
        if (!executed) await this.releaseExecute(p.id);
      } else {
        verification = await adapter.verify(this.ctxFor(p));
      }
    } catch {
      verification = { kind: "indeterminate", code: "ADAPTER_ERROR" };
    }
    await this.applyVerification(p.id, verification, { actor: opts.actor, source: opts.source, executed, expireIfStale });
  }

  /** bKash allows ONE execute per paymentId: exactly one caller wins this claim. */
  async claimExecute(paymentId: string): Promise<boolean> {
    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, executeStartedAt: null, status: { in: ["INITIATED", "PROCESSING"] } },
      data: { executeStartedAt: this.clock.now() },
    });
    return count === 1;
  }

  /** The execute request never reached the provider (e.g. no token): allow a later attempt. */
  async releaseExecute(paymentId: string) {
    await this.prisma.payment.updateMany({ where: { id: paymentId, status: "PROCESSING" }, data: { executeStartedAt: null } });
  }

  /** INITIATED -> PROCESSING when a callback proves the customer came back. Idempotent. */
  async markCallbackReceived(paymentId: string, actor: Actor, source: string) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!p) return;
      if (p.status === "INITIATED") {
        await changeStatus(tx, p, "PROCESSING", actor, { type: "payment.processing", metadata: { source } }, { callbackReceivedAt: now });
      } else if (!p.callbackReceivedAt && isOpen(p.status)) {
        await tx.payment.update({ where: { id: p.id }, data: { callbackReceivedAt: now } });
      }
    });
  }

  /**
   * Turn what the provider reported into payment state. This is the ONLY place a
   * payment becomes SUCCEEDED / REQUIRES_REVIEW from provider data.
   *
   * One transaction, booking lock then payment lock, so concurrent callbacks,
   * IPNs and polls for one booking apply one at a time. Repeating the same
   * information changes nothing and writes no events.
   */
  async applyVerification(paymentId: string, v: Verification, opts: ApplyOptions): Promise<void> {
    const now = this.clock.now();
    const notices: NewNotification[] = [];
    await this.prisma.$transaction(async (tx) => {
      notices.length = 0; // the callback runs again if the transaction is retried
      const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
      if (!head) return;
      await lockBooking(tx, head.bookingId);
      await lockPayment(tx, paymentId);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

      // "Provider verification attempted": one diagnostic row per distinct result per hour.
      const result = v.kind === "completed" ? "completed" : v.kind === "not_completed" ? `not_completed_${v.state}` : `inconclusive_${v.code}`;
      await recordEvent(tx, p.id, opts.actor, {
        type: "payment.verification_checked",
        dedupeKey: `vc:${p.id}:${result}:${Math.floor(now.getTime() / 3_600_000)}`,
        metadata: { source: opts.source, result },
      });

      if (v.kind === "indeterminate") return; // unknown stays unknown

      if (v.kind === "not_completed") {
        await this.applyNotCompleted(tx, p, v.state, opts, notices);
        return;
      }
      await this.applyCompleted(tx, p, v, opts.actor, now, notices);
    });
    // Committed. Telling people about it is best effort and can never undo the payment or the booking.
    await this.notifications.notifyBestEffort(notices);
  }

  private async applyNotCompleted(tx: Tx, p: Payment, state: "pending" | "failed" | "cancelled" | "unknown", opts: ApplyOptions, notices: NewNotification[]) {
    if (!isOpen(p.status)) return; // terminal states are never changed by a non-payment report
    const actor = opts.actor;
    const fail = async (to: "FAILED" | "CANCELLED" | "EXPIRED", code: string) => {
      await changeStatus(tx, p, to, actor, { type: `payment.${to.toLowerCase()}`, metadata: { source: opts.source, code } }, { failureCode: code });
      // A failed attempt needs the customer to act (retry); a cancelled or abandoned one was their own choice.
      if (to === "FAILED") {
        notices.push({
          userId: p.customerId,
          type: "payment.failed",
          title: "Your payment did not go through",
          body: "The payment was not completed and nothing was charged to this booking. You can try again from the booking page.",
          link: `/bookings/${p.bookingId}`,
        });
      }
    };

    const outcome = state === "failed" || state === "cancelled" ? state : opts.claim;
    if (outcome === "cancelled") return fail("CANCELLED", "CANCELLED_BY_CUSTOMER");
    if (outcome === "failed") return fail("FAILED", "PROVIDER_REPORTED_FAILURE");
    // The one-shot execute ran and the provider STILL says unpaid: that paymentId is dead.
    if (opts.executed && state === "pending") return fail("FAILED", "NOT_COMPLETED_AFTER_EXECUTE");
    if (opts.expireIfStale && (p.status === "PENDING" || p.status === "INITIATED")) return fail("EXPIRED", "ABANDONED");
    // PROCESSING (a callback arrived) is never auto-expired: it waits for the provider or an admin.
  }

  private async applyCompleted(
    tx: Tx,
    p: Payment,
    v: Extract<Verification, { kind: "completed" }>,
    actor: Actor,
    now: Date,
    notices: NewNotification[],
  ) {
    // Already settled: replays and late duplicates change nothing.
    if (isPaid(p.status) || p.status === "REQUIRES_REVIEW") {
      if (p.providerTransactionId && v.providerTransactionId !== p.providerTransactionId) {
        await recordEvent(tx, p.id, actor, {
          type: "payment.provider_mismatch",
          dedupeKey: `mm:${p.id}:${v.providerTransactionId}`,
          metadata: { note: "A different provider transaction was reported for an already settled payment" },
        });
      }
      return;
    }

    let reason: PaymentReviewReason | null = null;
    if (v.reference !== p.reference) reason = "REFERENCE_MISMATCH";
    else if (v.providerPaymentId && p.providerPaymentId && v.providerPaymentId !== p.providerPaymentId) reason = "REFERENCE_MISMATCH";
    else if (v.currency !== p.currency) reason = "CURRENCY_MISMATCH";
    else if (v.amountPoisha !== p.amountBdt * 100) reason = "AMOUNT_MISMATCH";

    // The same provider transaction must never settle two attempts.
    const reused = await tx.payment.findFirst({
      where: { provider: p.provider, providerTransactionId: v.providerTransactionId, id: { not: p.id } },
      select: { id: true },
    });
    if (reused) reason ??= "REFERENCE_MISMATCH";
    if (p.status === "PENDING") reason ??= "REFERENCE_MISMATCH"; // paid at the provider but we never recorded a session

    const park = async (why: PaymentReviewReason) => {
      notices.push({
        userId: p.customerId,
        type: "payment.requires_review",
        title: "Your payment is being checked",
        body: "We received a payment report for your booking that needs a manual check. Please do not pay again; the booking stays unpaid until it is resolved.",
        link: `/bookings/${p.bookingId}`,
      });
      await changeStatus(tx, p, "REQUIRES_REVIEW", actor, {
        type: "payment.requires_review",
        metadata: { reason: why, reportedAmountPoisha: v.amountPoisha, reportedCurrency: v.currency },
      }, {
        reviewReason: why,
        ...(reused ? {} : { providerTransactionId: v.providerTransactionId, providerValidationId: v.providerValidationId }),
      });
    };

    if (reason) return park(reason);
    if (v.riskFlagged) return park("PROVIDER_RISK_FLAG");

    const duplicate = await tx.payment.findFirst({
      where: {
        bookingId: p.bookingId,
        id: { not: p.id },
        status: { in: [...PAID_PAYMENT_STATUSES] },
        OR: [{ reviewReason: null }, { reviewReason: { not: "DUPLICATE_PAYMENT" } }],
      },
      select: { id: true },
    });
    if (duplicate) return park("DUPLICATE_PAYMENT");

    // Verified: amount, currency, reference and provider ids all match.
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: p.bookingId },
      select: { id: true, status: true, category: { select: { name: true } }, workerProfile: { select: { userId: true, displayName: true } } },
    });
    const ineligible = !PAYABLE_BOOKING_STATUSES.includes(booking.status);
    await changeStatus(tx, p, "SUCCEEDED", actor, {
      type: "payment.succeeded",
      dedupeKey: `succeeded:${p.id}`,
      metadata: { provider: p.provider, bookingStatus: booking.status, ineligibleBooking: ineligible },
    }, {
      providerTransactionId: v.providerTransactionId,
      providerValidationId: v.providerValidationId ?? p.providerValidationId,
      succeededAt: now,
      failureCode: null,
      reviewReason: ineligible ? "BOOKING_INELIGIBLE" : null,
    });
    await tx.bookingEvent.create({
      data: {
        bookingId: p.bookingId,
        actorUserId: null,
        actorRole: "SYSTEM",
        type: "payment.verified",
        metadata: { provider: p.provider, bookingStatus: booking.status },
      },
    });
    // A verified payment is the ONLY thing that completes a booking whose work is finished. We hold the booking
    // lock, so the status cannot change under us. Any other status (a dispute, a cancellation) is left exactly as
    // it is: a late payment never reactivates a cancelled or disputed booking, and a booking an administrator
    // already completed stays completed. Those payments are flagged BOOKING_INELIGIBLE or simply recorded.
    if (booking.status === "COMPLETION_PENDING") {
      await this.core.transition(tx, { id: booking.id, status: booking.status }, "payment_verified", SYSTEM, {
        data: { completedAt: now },
        eventType: "booking.completed",
        metadata: { paymentReference: p.reference, provider: p.provider },
      });
    }
    notices.push({
      userId: p.customerId,
      type: "payment.succeeded",
      title: "Payment received",
      body: `Your ৳${p.amountBdt} payment for ${booking.category.name} was verified.${booking.status === "COMPLETION_PENDING" ? " The booking is complete and you can now leave a review." : ""}`,
      link: `/bookings/${p.bookingId}`,
    });
    notices.push({
      userId: booking.workerProfile.userId,
      type: "payment.succeeded",
      title: "The customer's payment was verified",
      body: `Payment for the ${booking.category.name} booking was verified${booking.status === "COMPLETION_PENDING" ? " and the booking is complete" : ""}.`,
      link: `/bookings/${p.bookingId}`,
    });
  }

  // ================================================================ admin

  /**
   * Re-ask the provider about one payment. Idempotent and audited. It can
   * discover a late success; it can never invent one.
   */
  async adminReconcile(admin: AuthContext, reference: string) {
    const p = await this.prisma.payment.findUnique({ where: { reference }, select: { id: true, status: true, booking: { select: { customerId: true, workerProfile: { select: { userId: true } } } } } });
    if (!p) throw new NotFoundException("Payment not found");
    this.assertNotParty(admin, p.booking);
    const before = p.status;
    await this.prisma.auditLog.create({
      data: { actorId: admin.userId, action: "payment.reconcile", targetType: "Payment", targetId: p.id, metadata: { statusBefore: before } },
    });
    await this.reverify(p.id, { actor: { userId: admin.userId, role: "ADMIN" }, source: "reconcile", force: true });
    return this.adminDetail(reference);
  }

  /** Re-verify a batch of stale unresolved payments (also used by the operator script). */
  async reconcileStale(actor: Actor, limit = MAX_RECONCILE_BATCH) {
    const now = this.clock.now();
    const stale = await this.prisma.payment.findMany({
      where: {
        status: { in: [...OPEN_PAYMENT_STATUSES] },
        createdAt: { lt: new Date(now.getTime() - minutes(2)) },
        OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now.getTime() - minutes(1)) } }],
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(limit, MAX_RECONCILE_BATCH),
      select: { id: true, reference: true },
    });
    for (const p of stale) await this.reverify(p.id, { actor, source: "reconcile_batch" });
    const after = await this.prisma.payment.findMany({ where: { id: { in: stale.map((s) => s.id) } }, select: { status: true } });
    const counts: Record<string, number> = {};
    for (const a of after) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return { checked: stale.length, statuses: counts };
  }

  /** Admins may not act on payments for bookings they take part in. */
  assertNotParty(admin: AuthContext, booking: { customerId: string; workerProfile: { userId: string } }) {
    if (booking.customerId === admin.userId || booking.workerProfile.userId === admin.userId) {
      throw new NotFoundException("Payment not found");
    }
  }

  async adminList(q: AdminPaymentsQuery) {
    const { status, page, pageSize } = q;
    const term = q.q?.trim();
    const where: Prisma.PaymentWhereInput = {
      ...(status === "NEEDS_ATTENTION"
        ? { OR: [{ status: "REQUIRES_REVIEW" as const }, { reviewReason: "BOOKING_INELIGIBLE" as const }] }
        : status
          ? { status }
          : {}),
      ...(q.provider && { provider: q.provider }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
      ...(term && { AND: [{ OR: [{ reference: { contains: term, mode: "insensitive" as const } }, ...(/^[0-9a-f-]{36}$/i.test(term) ? [{ bookingId: term }] : [])] }] }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: { select: { id: true, name: true } } },
      }),
    ]);
    return {
      payments: rows.map(({ customer, ...p }) => ({ ...presentPayment(p), customer, reviewReason: p.reviewReason, verificationAttempts: p.verificationAttempts, lastVerifiedAt: p.lastVerifiedAt })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async adminDetail(reference: string) {
    const p = await this.prisma.payment.findUnique({
      where: { reference },
      include: {
        refunds: { orderBy: [{ createdAt: "desc" }, { id: "asc" }] },
        events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 },
        booking: { select: { id: true, status: true, category: { select: { name: true } } } },
      },
    });
    if (!p) throw new NotFoundException("Payment not found");
    return {
      payment: {
        ...presentPayment(p, { refunds: p.refunds }),
        reviewReason: p.reviewReason,
        failureCode: p.failureCode,
        verificationAttempts: p.verificationAttempts,
        lastVerifiedAt: p.lastVerifiedAt,
        booking: { id: p.booking.id, status: p.booking.status, serviceName: p.booking.category.name },
        // Admin sees every event with its sanitised metadata (never provider payloads).
        events: p.events.map((e) => ({ type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, actorRole: e.actorRole, metadata: e.metadata, createdAt: e.createdAt })),
      },
    };
  }
}
