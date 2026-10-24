import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict, isUniqueViolation, unprocessable } from "../bookings/domain-errors.js";
import { Clock } from "../bookings/clock.js";
import type { Prisma, Refund, RefundStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { changeStatus, lockBooking, lockPayment, newReference, recordEvent, type Actor, type Tx } from "./payment.db.js";
import { REFUNDABLE_PAYMENT_STATUSES, assertRefundTransition } from "./payment.state.js";
import { presentRefund } from "./payment.view.js";
import { PaymentsService } from "./payments.service.js";
import { PaymentProviders } from "./providers/providers.service.js";
import type { RefundStatusResult } from "./providers/payment-provider.js";

export type RefundRequestInput = { amountBdt?: number; reason: string };

type LockedPayment = Prisma.PaymentGetPayload<{
  include: { booking: { select: { customerId: true; workerProfile: { select: { userId: true } } } } };
}>;

/**
 * Refund workflow. Honest by construction:
 *  - a REQUEST is a customer asking; an APPROVAL is an admin deciding. Neither moves money.
 *  - money is only considered refunded when the PROVIDER confirms it through its
 *    refund-status API (a refund the provider merely accepted stays PROCESSING).
 *  - the payment's refundedAmountBdt changes only on that confirmed transition,
 *    inside one transaction, and only once.
 *  - at most one open refund per payment (partial unique index), so concurrent
 *    requests cannot claim the same remaining balance twice.
 * If the provider's refund API is not enabled for this merchant, processing is
 * refused with REFUNDS_NOT_SUPPORTED; refunds done by hand in the provider's panel
 * are NOT recorded as successful by this system.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly providers: PaymentProviders,
    private readonly clock: Clock,
  ) {}

  private actorOf(auth: AuthContext, role: "CUSTOMER" | "ADMIN"): Actor {
    return { userId: auth.userId, role };
  }

  // ================================================================ request

  /** Customer asks for a refund of their own verified payment. */
  async request(auth: AuthContext, reference: string, input: RefundRequestInput, idempotencyKey: string | undefined) {
    const found = await this.prisma.payment.findUnique({ where: { reference }, select: { id: true, bookingId: true, customerId: true } });
    if (!found || found.customerId !== auth.userId) throw new NotFoundException("Payment not found");

    const refund = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, found.bookingId);
      await lockPayment(tx, found.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, include: { booking: { select: { status: true } } } });

      if (idempotencyKey) {
        const existing = await tx.refund.findUnique({ where: { requestedByUserId_idempotencyKey: { requestedByUserId: auth.userId, idempotencyKey } } });
        if (existing) {
          if (existing.paymentId !== p.id) throw conflict("IDEMPOTENCY_KEY_REUSED", "That request key was already used for a different refund");
          return existing;
        }
      }
      if (!REFUNDABLE_PAYMENT_STATUSES.includes(p.status)) {
        throw unprocessable("PAYMENT_NOT_REFUNDABLE", "Only a payment that was verified as received can be refunded");
      }
      // No refund policy exists yet (docs/PAYMENTS.md): the only self-service case is a cancelled booking.
      if (p.booking.status !== "CANCELLED") {
        throw unprocessable(
          "REFUND_NOT_ELIGIBLE",
          "Refunds can be requested once the booking is cancelled. If there is a problem with the work, report it from the booking page instead.",
        );
      }
      return this.createRequested(tx, p, this.actorOf(auth, "CUSTOMER"), input, idempotencyKey);
    });
    return { refund: presentRefund(refund) };
  }

  private async createRequested(
    tx: Tx,
    p: { id: string; amountBdt: number; refundedAmountBdt: number },
    actor: Actor,
    input: RefundRequestInput,
    idempotencyKey: string | undefined,
    autoApprove = false,
  ): Promise<Refund> {
    const remaining = p.amountBdt - p.refundedAmountBdt;
    const amount = input.amountBdt ?? remaining;
    if (remaining <= 0) throw unprocessable("NOTHING_TO_REFUND", "This payment has already been fully refunded");
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw unprocessable("REFUND_EXCEEDS_REMAINING", `You can request at most ৳${remaining} for this payment`);
    }
    let refund: Refund;
    try {
      refund = await tx.refund.create({
        data: {
          paymentId: p.id,
          requestedByUserId: actor.userId!,
          requestedByRole: actor.role,
          requestedAmountBdt: amount,
          approvedAmountBdt: autoApprove ? amount : null,
          reason: input.reason,
          status: autoApprove ? "APPROVED" : "REQUESTED",
          decidedByUserId: autoApprove ? actor.userId : null,
          decidedAt: autoApprove ? this.clock.now() : null,
          providerRefundReference: newReference("RFD"),
          idempotencyKey: idempotencyKey ?? null,
          createdAt: this.clock.now(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("REFUND_IN_PROGRESS", "A refund for this payment is already open");
      throw error;
    }
    await recordEvent(tx, p.id, actor, { type: "refund.requested", refundId: refund.id, metadata: { amountBdt: amount } });
    if (autoApprove) await recordEvent(tx, p.id, actor, { type: "refund.approved", refundId: refund.id, metadata: { amountBdt: amount } });
    return refund;
  }

  // ================================================================ admin decisions

  private async adminAct<T>(
    admin: AuthContext,
    refundId: string,
    work: (tx: Tx, refund: Refund, payment: LockedPayment) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const { refund, payment } = await this.loadLocked(tx, refundId);
      this.payments.assertNotParty(admin, payment.booking);
      return work(tx, refund, payment);
    });
  }

  private async loadLocked(tx: Tx, refundId: string) {
    const head = await tx.refund.findUnique({ where: { id: refundId }, select: { paymentId: true, payment: { select: { bookingId: true } } } });
    if (!head) throw new NotFoundException("Refund not found");
    await lockBooking(tx, head.payment.bookingId);
    await lockPayment(tx, head.paymentId);
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: head.paymentId },
      include: { booking: { select: { customerId: true, workerProfile: { select: { userId: true } } } } },
    });
    return { refund, payment };
  }

  /** Conditional refund transition + history, in the caller's transaction. */
  private async moveRefund(tx: Tx, refund: Refund, to: RefundStatus, actor: Actor, eventType: string, data: Prisma.RefundUncheckedUpdateManyInput = {}, metadata?: Record<string, string | number>) {
    assertRefundTransition(refund.status, to);
    const { count } = await tx.refund.updateMany({ where: { id: refund.id, status: refund.status }, data: { ...data, status: to } });
    if (count === 0) throw conflict("STALE_REFUND", "This refund just changed. Please refresh.");
    await recordEvent(tx, refund.paymentId, actor, { type: eventType, refundId: refund.id, metadata });
  }

  private audit(tx: Tx, admin: AuthContext, action: string, refundId: string, metadata?: Record<string, string | number>) {
    return tx.auditLog.create({ data: { actorId: admin.userId, action, targetType: "Refund", targetId: refundId, metadata } });
  }

  /** Admin starts a refund themselves (e.g. a duplicate payment, or a dispute outcome). Already approved. */
  async adminCreate(admin: AuthContext, reference: string, input: RefundRequestInput, idempotencyKey: string | undefined) {
    const found = await this.prisma.payment.findUnique({
      where: { reference },
      select: { id: true, bookingId: true, booking: { select: { customerId: true, workerProfile: { select: { userId: true } } } } },
    });
    if (!found) throw new NotFoundException("Payment not found");
    this.payments.assertNotParty(admin, found.booking);

    const refund = await this.prisma.$transaction(async (tx) => {
      await lockBooking(tx, found.bookingId);
      await lockPayment(tx, found.id);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: found.id } });
      if (idempotencyKey) {
        const existing = await tx.refund.findUnique({ where: { requestedByUserId_idempotencyKey: { requestedByUserId: admin.userId, idempotencyKey } } });
        if (existing) {
          if (existing.paymentId !== p.id) throw conflict("IDEMPOTENCY_KEY_REUSED", "That request key was already used for a different refund");
          return existing;
        }
      }
      // A duplicate payment (money verified, amount matched) is refundable though it never became SUCCEEDED.
      const duplicate = p.status === "REQUIRES_REVIEW" && p.reviewReason === "DUPLICATE_PAYMENT";
      if (!REFUNDABLE_PAYMENT_STATUSES.includes(p.status) && !duplicate) {
        throw unprocessable("PAYMENT_NOT_REFUNDABLE", "Only a payment verified as received (or a verified duplicate) can be refunded");
      }
      const created = await this.createRequested(tx, p, this.actorOf(admin, "ADMIN"), input, idempotencyKey, true);
      await this.audit(tx, admin, "refund.create", created.id, { amountBdt: created.requestedAmountBdt });
      return created;
    });
    return { refund: presentRefund(refund) };
  }

  /** Approve = the platform agrees to refund. It does NOT move money or mark anything refunded. */
  async approve(admin: AuthContext, refundId: string, body: { amountBdt?: number; note?: string }) {
    return this.adminAct(admin, refundId, async (tx, refund, payment) => {
      if (refund.status !== "REQUESTED") throw conflict("INVALID_REFUND_TRANSITION", `A ${refund.status.toLowerCase()} refund cannot be approved`);
      const remaining = payment.amountBdt - payment.refundedAmountBdt;
      const amount = body.amountBdt ?? refund.requestedAmountBdt;
      if (amount > refund.requestedAmountBdt || amount > remaining || amount <= 0) {
        throw unprocessable("REFUND_EXCEEDS_REMAINING", `The approved amount must be between ৳1 and ৳${Math.min(refund.requestedAmountBdt, remaining)}`);
      }
      await this.moveRefund(tx, refund, "APPROVED", this.actorOf(admin, "ADMIN"), "refund.approved", {
        approvedAmountBdt: amount,
        decidedByUserId: admin.userId,
        decidedAt: this.clock.now(),
        decisionNote: body.note ?? null,
      }, { amountBdt: amount });
      await this.audit(tx, admin, "refund.approve", refund.id, { amountBdt: amount });
      return { refund: presentRefund(await tx.refund.findUniqueOrThrow({ where: { id: refund.id } })) };
    });
  }

  async reject(admin: AuthContext, refundId: string, note: string) {
    return this.adminAct(admin, refundId, async (tx, refund) => {
      if (refund.status !== "REQUESTED" && refund.status !== "APPROVED") {
        throw conflict("INVALID_REFUND_TRANSITION", `A ${refund.status.toLowerCase()} refund cannot be rejected`);
      }
      await this.moveRefund(tx, refund, "REJECTED", this.actorOf(admin, "ADMIN"), "refund.rejected", {
        decidedByUserId: admin.userId,
        decidedAt: this.clock.now(),
        decisionNote: note,
      });
      await this.audit(tx, admin, "refund.reject", refund.id);
      return { refund: presentRefund(await tx.refund.findUniqueOrThrow({ where: { id: refund.id } })) };
    });
  }

  // ================================================================ provider execution

  /**
   * Ask the provider to refund an approved refund. The provider call happens
   * outside any transaction. The refund only becomes SUCCEEDED when the
   * provider's refund-status API confirms it (see `verify`).
   */
  async process(admin: AuthContext, refundId: string) {
    const claimed = await this.adminAct(admin, refundId, async (tx, refund, payment) => {
      if (refund.status !== "APPROVED") throw conflict("INVALID_REFUND_TRANSITION", `A ${refund.status.toLowerCase()} refund cannot be processed`);
      const adapter = this.providers.get(payment.provider);
      if (!adapter?.refundsEnabled) {
        throw unprocessable(
          "REFUNDS_NOT_SUPPORTED",
          "Automatic refunds are not enabled for this payment provider. The refund stays approved; it must be completed in the provider's merchant panel, and this system does not record unverified refunds.",
        );
      }
      if (!payment.providerTransactionId) throw unprocessable("PAYMENT_NOT_REFUNDABLE", "This payment has no verified provider transaction");
      const remaining = payment.amountBdt - payment.refundedAmountBdt;
      if (refund.approvedAmountBdt === null || refund.approvedAmountBdt > remaining) {
        throw unprocessable("REFUND_EXCEEDS_REMAINING", "The approved amount exceeds the remaining refundable amount");
      }
      await this.moveRefund(tx, refund, "PROCESSING", this.actorOf(admin, "ADMIN"), "refund.processing", { processStartedAt: this.clock.now() });
      await this.audit(tx, admin, "refund.process", refund.id, { amountBdt: refund.approvedAmountBdt });
      return { refund: { ...refund, status: "PROCESSING" as const }, payment, amountBdt: refund.approvedAmountBdt, adapter };
    });

    const { refund, payment, amountBdt, adapter } = claimed;
    const actor = this.actorOf(admin, "ADMIN");
    let result;
    try {
      result = await adapter.refund({
        providerPaymentId: payment.providerPaymentId,
        providerTransactionId: payment.providerTransactionId!,
        refundReference: refund.providerRefundReference,
        amountBdt,
        reason: refund.reason,
        paymentReference: payment.reference,
      });
    } catch {
      result = { kind: "indeterminate" as const, code: "ADAPTER_ERROR" };
    }

    if (result.kind === "rejected") {
      await this.fail(refund.id, actor, `REJECTED_${result.code}`);
    } else if (result.kind === "accepted") {
      if (result.providerRefundId) {
        await this.prisma.refund.updateMany({ where: { id: refund.id, status: "PROCESSING" }, data: { providerRefundId: result.providerRefundId } });
      }
      await this.verify(refund.id, actor); // independent confirmation
    }
    // indeterminate: stays PROCESSING. NEVER re-sent automatically: a retry could refund twice.
    return this.adminDetail(refund.id);
  }

  /** Re-ask the provider about a PROCESSING refund. Idempotent. */
  async reconcile(admin: AuthContext, refundId: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: { select: { booking: { select: { customerId: true, workerProfile: { select: { userId: true } } } } } } } });
    if (!refund) throw new NotFoundException("Refund not found");
    this.payments.assertNotParty(admin, refund.payment.booking);
    await this.prisma.auditLog.create({ data: { actorId: admin.userId, action: "refund.reconcile", targetType: "Refund", targetId: refund.id } });
    if (refund.status === "PROCESSING") await this.verify(refund.id, this.actorOf(admin, "ADMIN"));
    return this.adminDetail(refund.id);
  }

  private async fail(refundId: string, actor: Actor, code: string) {
    await this.prisma.$transaction(async (tx) => {
      const { refund } = await this.loadLocked(tx, refundId);
      if (refund.status !== "PROCESSING") return;
      await this.moveRefund(tx, refund, "FAILED", actor, "refund.failed", { failureCode: code.slice(0, 60) }, { code: code.slice(0, 60) });
    });
  }

  /** Apply the provider's refund-status answer. The only way a refund becomes SUCCEEDED. */
  async verify(refundId: string, actor: Actor): Promise<void> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!refund || refund.status !== "PROCESSING") return;
    const adapter = this.providers.get(refund.payment.provider);
    if (!adapter || !refund.payment.providerTransactionId || refund.approvedAmountBdt === null) return;

    let status: RefundStatusResult;
    try {
      status = await adapter.refundStatus({
        providerPaymentId: refund.payment.providerPaymentId,
        providerTransactionId: refund.payment.providerTransactionId,
        providerRefundId: refund.providerRefundId,
        refundReference: refund.providerRefundReference,
        amountBdt: refund.approvedAmountBdt,
      });
    } catch {
      status = { kind: "indeterminate", code: "ADAPTER_ERROR" };
    }
    await this.prisma.refund.update({ where: { id: refund.id }, data: { lastVerifiedAt: this.clock.now() } });

    if (status.kind === "failed") return this.fail(refund.id, actor, status.code);
    if (status.kind !== "refunded") return; // processing / inconclusive: unknown stays unknown

    await this.prisma.$transaction(async (tx) => {
      const { refund: r, payment: p } = await this.loadLocked(tx, refund.id);
      if (r.status !== "PROCESSING" || r.approvedAmountBdt === null) return; // someone else already finished it
      // The provider must confirm the amount we asked for (when it reports one).
      if (status.amountPoisha !== null && status.amountPoisha !== r.approvedAmountBdt * 100) {
        await recordEvent(tx, p.id, actor, { type: "refund.amount_mismatch", refundId: r.id, dedupeKey: `rm:${r.id}`, metadata: { reportedPoisha: status.amountPoisha } });
        return;
      }
      const newTotal = p.refundedAmountBdt + r.approvedAmountBdt;
      if (newTotal > p.amountBdt) {
        await recordEvent(tx, p.id, actor, { type: "refund.over_refund_blocked", refundId: r.id, dedupeKey: `or:${r.id}` });
        return;
      }
      await this.moveRefund(tx, r, "SUCCEEDED", actor, "refund.succeeded", {
        completedAt: this.clock.now(),
        providerRefundId: status.providerRefundId ?? r.providerRefundId,
      }, { amountBdt: r.approvedAmountBdt });
      const to = newTotal === p.amountBdt ? "REFUNDED" : "PARTIALLY_REFUNDED";
      if (p.status === to) {
        await tx.payment.update({ where: { id: p.id }, data: { refundedAmountBdt: newTotal } });
      } else {
        await changeStatus(tx, p, to, actor, { type: to === "REFUNDED" ? "payment.refunded" : "payment.partially_refunded", refundId: r.id, metadata: { refundedAmountBdt: newTotal } }, { refundedAmountBdt: newTotal });
      }
    });
  }

  // ================================================================ admin reads

  async adminList(status: RefundStatus | undefined, page: number, pageSize: number) {
    const where = status ? { status } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { payment: { select: { reference: true, provider: true, amountBdt: true, refundedAmountBdt: true, status: true } } },
      }),
    ]);
    return {
      refunds: rows.map((r) => ({ ...presentRefund(r), requestedByRole: r.requestedByRole, failureCode: r.failureCode, payment: r.payment })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async adminDetail(refundId: string) {
    const r = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: { select: { reference: true, provider: true, amountBdt: true, refundedAmountBdt: true, status: true } } },
    });
    if (!r) throw new NotFoundException("Refund not found");
    return { refund: { ...presentRefund(r), requestedByRole: r.requestedByRole, failureCode: r.failureCode, payment: r.payment } };
  }
}

