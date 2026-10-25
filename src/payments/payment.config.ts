/**
 * Payment policy constants. They are code, not environment, because changing
 * them changes documented behaviour (docs/PAYMENTS.md) and tests.
 */
import type { BookingStatus, PaymentStatus } from "../generated/prisma/client.js";

export const CURRENCY = "BDT";

/**
 * Booking statuses in which the agreed amount may be paid: once the professional reported the work finished
 * (COMPLETION_PENDING = payment due). COMPLETED stays payable for the one case where an administrator
 * completed a disputed booking that was never paid; paying it completes nothing further. Payment never gates
 * confirmation, but it does gate completion and reviews (docs/PAYMENTS.md).
 */
export const PAYABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["COMPLETION_PENDING", "COMPLETED"];

/** Attempts that may still turn into a payment (a provider outcome is awaited). */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ["PENDING", "INITIATED", "PROCESSING"];

/** Statuses meaning "the booking's obligation is paid" (one per booking, enforced by the database). */
export const PAID_PAYMENT_STATUSES: readonly PaymentStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"];

/** A PENDING row whose provider call never completed is expired after this long. */
export const PENDING_ABANDON_MINUTES = 5;
/**
 * An INITIATED attempt with no verified outcome is expired after this long, but
 * only once the provider has confirmed it is not paid. If the customer pays the
 * old session later, the late success is still recorded (see PaymentsService).
 */
export const INITIATED_ABANDON_MINUTES = 30;
/** Minimum gap between provider lookups for one payment (lazy re-verification). */
export const REVERIFY_MIN_SECONDS = 10;
/** Provider HTTP timeout (both providers document 30 s). */
export const PROVIDER_TIMEOUT_MS = 30_000;

export const MAX_REFUND_REASON = 500;
export const MIN_REFUND_REASON = 10;
export const MAX_RECONCILE_BATCH = 20;

/** Abuse guard: attempts a customer may create for one booking per hour. */
export const MAX_ATTEMPTS_PER_BOOKING_PER_HOUR = 10;
