import type { PaymentProvider } from "../../generated/prisma/client.js";

/**
 * Provider adapters speak ONE provider's protocol and translate it into these
 * neutral results. They never touch the database and never decide whether a
 * payment is accepted: PaymentsService compares a `completed` result with the
 * stored attempt (reference, amount, currency, provider ids) and owns all state.
 */

/**
 * The real payment provider (bKash) and the simulated one that only demo accounts can use (docs/DEMO.md).
 * (The database enum still lists SSLCOMMERZ for historical rows; nothing creates them.)
 */
export type ProviderId = "BKASH" | "DEMO";

export type InitiateInput = {
  /** Our opaque reference; sent as the provider's transaction/invoice id. */
  reference: string;
  /** Whole taka, always derived on the server from the booking. */
  amountBdt: number;
  /** Where the provider sends the customer's browser afterwards (untrusted). */
  urls: { callback: string };
  customer: { name: string; email: string };
  productName: string;
};

export type InitiateResult =
  | { kind: "ok"; providerPaymentId: string; checkoutUrl: string }
  /** The provider answered and refused. No session exists, so no charge is possible. */
  | { kind: "rejected"; code: string }
  /** No usable answer. No checkout URL was issued, so no charge is possible. */
  | { kind: "unreachable"; code: string };

export type VerifyContext = {
  reference: string;
  providerPaymentId: string | null;
  providerValidationId: string | null;
  amountBdt: number;
};

/**
 * What the provider says about a transaction. Fields are what the provider
 * REPORTED (null when it did not report them); comparing them with the stored
 * attempt is PaymentsService's job.
 */
export type Verification =
  | {
      kind: "completed";
      reference: string | null;
      providerPaymentId: string | null;
      providerTransactionId: string;
      providerValidationId: string | null;
      amountPoisha: number | null;
      currency: string | null;
      /** Provider flagged the transaction as risky and wants the merchant to review it. */
      riskFlagged: boolean;
    }
  | {
      kind: "not_completed";
      /**
       * pending: the provider has not seen a completed payment (it may still be paid);
       * failed / cancelled: the provider reports a terminal non-payment;
       * unknown: the provider has no such transaction.
       */
      state: "pending" | "failed" | "cancelled" | "unknown";
    }
  /** Timeout, 5xx, auth problem, unparseable answer: the true state is UNKNOWN. */
  | { kind: "indeterminate"; code: string };

export type ApprovalResult = {
  verification: Verification;
  /** True when the provider's one-shot execute step was attempted (bKash). */
  executed: boolean;
};

export type RefundInput = {
  providerPaymentId: string | null;
  providerTransactionId: string;
  /** Our unique id for this refund. */
  refundReference: string;
  amountBdt: number;
  reason: string;
  paymentReference: string;
};

export type RefundResult =
  /** The provider accepted the request. It may already be complete; `RefundStatusResult` decides. */
  | { kind: "accepted"; providerRefundId: string | null }
  | { kind: "rejected"; code: string }
  | { kind: "indeterminate"; code: string };

export type RefundStatusInput = {
  providerPaymentId: string | null;
  providerTransactionId: string;
  providerRefundId: string | null;
  refundReference: string;
  amountBdt: number;
};

export type RefundStatusResult =
  | { kind: "refunded"; providerRefundId: string | null; amountPoisha: number | null }
  | { kind: "processing" }
  | { kind: "failed"; code: string }
  | { kind: "indeterminate"; code: string };

export interface PaymentProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly isLive: boolean;
  readonly refundsEnabled: boolean;
  /** Inclusive amount limits the provider accepts. */
  readonly amountLimitsBdt: { min: number; max: number };
  /** Hosts a checkout URL must belong to (suffix match); anything else is rejected. */
  readonly checkoutHostSuffixes: readonly string[];

  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Ask the provider (server to server) whether this transaction was paid. */
  verify(ctx: VerifyContext): Promise<Verification>;
  /**
   * Provider-specific step after the customer approved (bKash "execute", which
   * may run once per payment). Absent when the provider needs none.
   */
  completeAfterApproval?(ctx: VerifyContext): Promise<ApprovalResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  refundStatus(input: RefundStatusInput): Promise<RefundStatusResult>;
}

/** Strip anything that is not a short safe token before it is stored or shown. */
export function safeCode(value: unknown, fallback = "UNKNOWN"): string {
  return typeof value === "string" || typeof value === "number"
    ? (String(value).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || fallback)
    : fallback;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
