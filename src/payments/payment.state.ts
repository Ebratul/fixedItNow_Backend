import type { PaymentStatus, RefundStatus } from "../generated/prisma/client.js";

/**
 * Payment state machine. Every status change goes through `assertPaymentTransition`.
 *
 *   PENDING ──► INITIATED ──► PROCESSING ──► SUCCEEDED ──► PARTIALLY_REFUNDED ──► REFUNDED
 *      │            │              │             └────────────────────────────────►┘
 *      ▼            ▼              ▼
 *   FAILED / EXPIRED / CANCELLED  (not final: a provider-verified late success may follow)
 *
 * SUCCEEDED / REFUND* are only ever reached after provider verification. A late
 * FAILED / CANCELLED / EXPIRED can never downgrade a success (no edge leads out
 * of SUCCEEDED except to a refund state). REQUIRES_REVIEW is a parking state for
 * money the platform cannot accept automatically.
 */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["INITIATED", "FAILED", "EXPIRED", "REQUIRES_REVIEW"],
  INITIATED: ["PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "REQUIRES_REVIEW"],
  PROCESSING: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "REQUIRES_REVIEW"],
  FAILED: ["SUCCEEDED", "REQUIRES_REVIEW"],
  CANCELLED: ["SUCCEEDED", "REQUIRES_REVIEW"],
  EXPIRED: ["SUCCEEDED", "REQUIRES_REVIEW"],
  SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  REQUIRES_REVIEW: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED: [],
};

export class InvalidPaymentTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`Payment cannot move from ${from} to ${to}`);
  }
}

export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus) =>
  PAYMENT_TRANSITIONS[from].includes(to);

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!canTransitionPayment(from, to)) throw new InvalidPaymentTransitionError(from, to);
}

/** Statuses from which a refund can be requested (money was verifiably received). */
export const REFUNDABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED"];

/**
 *   REQUESTED ──approve──► APPROVED ──process──► PROCESSING ──provider-verified──► SUCCEEDED
 *       │                      │                      └──provider-verified failure──► FAILED
 *       └──reject──► REJECTED  └──reject──► REJECTED
 * Approval is a decision, not money movement.
 */
const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["PROCESSING", "REJECTED"],
  PROCESSING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
};

export const canTransitionRefund = (from: RefundStatus, to: RefundStatus) =>
  REFUND_TRANSITIONS[from].includes(to);

export function assertRefundTransition(from: RefundStatus, to: RefundStatus) {
  if (!canTransitionRefund(from, to)) throw new Error(`Refund cannot move from ${from} to ${to}`);
}
