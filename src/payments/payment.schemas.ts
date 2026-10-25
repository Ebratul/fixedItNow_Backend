import { z } from "zod";
import { MAX_REFUND_REASON, MIN_REFUND_REASON } from "./payment.config.js";

const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} must be at least ${min} characters`).max(max, `${label} must be ${max} characters or fewer`);

/** The browser chooses a METHOD only. Amount, currency, customer and status are server-side; unknown keys are rejected. */
export const initiatePaymentSchema = z.strictObject({ provider: z.enum(["BKASH"]) });
export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;

const pagination = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
};
export const listPaymentsSchema = z.object(pagination);

const wholeTaka = z.number().int("Use whole taka").min(1).max(500_000);

export const refundRequestSchema = z.strictObject({
  amountBdt: wholeTaka.optional(),
  reason: text(MIN_REFUND_REASON, MAX_REFUND_REASON, "Reason"),
});

/**
 * Money-moving admin actions need an explicit `confirm: true` in the body, so a stray or replayed
 * request without it (and any client that forgets the confirmation step) is refused with a 400.
 */
export const confirmSchema = z.strictObject({ confirm: z.literal(true, "Confirmation is required") });
export const confirmedRefundRequestSchema = refundRequestSchema.extend({ confirm: z.literal(true, "Confirmation is required") });
export const approveRefundSchema = z.strictObject({
  amountBdt: wholeTaka.optional(),
  note: text(1, 500, "Note").optional(),
  confirm: z.literal(true, "Confirmation is required"),
});
export const rejectRefundSchema = z.strictObject({ note: text(3, 500, "Note") });

const PAYMENT_STATUSES = [
  "PENDING", "INITIATED", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED",
  "REQUIRES_REVIEW", "PARTIALLY_REFUNDED", "REFUNDED", "NEEDS_ATTENTION",
] as const;
export const adminPaymentsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  provider: z.enum(["BKASH"]).optional(),
  /** Matches the payment reference, or the booking id when a full id is pasted. */
  q: z.string().trim().min(3).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pagination,
});
export type AdminPaymentsQuery = z.infer<typeof adminPaymentsQuerySchema>;
export const adminRefundsQuerySchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "PROCESSING", "SUCCEEDED", "FAILED", "REJECTED"]).optional(),
  ...pagination,
});

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
