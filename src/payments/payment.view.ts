import type { Payment, PaymentEvent, Refund } from "../generated/prisma/client.js";

/** Events a customer may see. Internal/diagnostic events never leave the server. */
const CUSTOMER_EVENTS = new Set([
  "payment.created",
  "payment.initiated",
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
  "payment.expired",
  "payment.requires_review",
  "refund.requested",
  "refund.approved",
  "refund.rejected",
  "refund.processing",
  "refund.succeeded",
  "refund.failed",
]);

export type RefundView = ReturnType<typeof presentRefund>;

export function presentRefund(r: Refund) {
  return {
    id: r.id,
    status: r.status,
    requestedAmountBdt: r.requestedAmountBdt,
    approvedAmountBdt: r.approvedAmountBdt,
    reason: r.reason,
    decisionNote: r.status === "REJECTED" || r.status === "APPROVED" ? r.decisionNote : null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    completedAt: r.completedAt,
  };
}

/**
 * Customer-facing payment. Contains no credentials, no provider session ids,
 * no checkout URL and no database ids. `providerTransactionId` is the receipt
 * number the customer also sees in their bKash / bank app, and is shown only
 * once the payment was verified.
 */
export function presentPayment(
  p: Payment,
  opts: { refunds?: Refund[]; events?: PaymentEvent[] } = {},
) {
  const paid = p.status === "SUCCEEDED" || p.status === "PARTIALLY_REFUNDED" || p.status === "REFUNDED";
  return {
    reference: p.reference,
    bookingId: p.bookingId,
    provider: p.provider,
    mode: p.provider === "DEMO" ? ("simulated" as const) : p.isLive ? ("live" as const) : ("sandbox" as const),
    status: p.status,
    amountBdt: p.amountBdt,
    currency: p.currency,
    refundedAmountBdt: p.refundedAmountBdt,
    refundableAmountBdt: p.status === "SUCCEEDED" || p.status === "PARTIALLY_REFUNDED" ? p.amountBdt - p.refundedAmountBdt : 0,
    /** True while the outcome is unknown or the platform is reviewing the money. */
    needsAttention: p.status === "REQUIRES_REVIEW" || p.reviewReason === "BOOKING_INELIGIBLE",
    bookingIneligible: p.reviewReason === "BOOKING_INELIGIBLE",
    providerTransactionId: paid ? p.providerTransactionId : null,
    createdAt: p.createdAt,
    succeededAt: p.succeededAt,
    refunds: opts.refunds?.map(presentRefund),
    events: opts.events
      ?.filter((e) => CUSTOMER_EVENTS.has(e.type))
      .map((e) => ({ type: e.type, toStatus: e.toStatus, createdAt: e.createdAt })),
  };
}
