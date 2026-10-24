import type { BookingStatus, Prisma } from "../generated/prisma/client.js";
import { OPEN_PAYMENT_STATUSES, PAID_PAYMENT_STATUSES, PAYABLE_BOOKING_STATUSES } from "./payment.config.js";
import { presentPayment } from "./payment.view.js";

type Booking = { id: string; status: BookingStatus; agreedAmountBdt: number | null; currency: string };

/**
 * Payment section of the booking detail. The customer sees their own attempts;
 * the professional only learns whether a verified payment exists, never failed
 * attempts, providers, references or amounts beyond the agreed price.
 */
export async function paymentSummary(tx: Prisma.TransactionClient, booking: Booking, viewer: "CUSTOMER" | "WORKER") {
  const rows = await tx.payment.findMany({
    where: { bookingId: booking.id },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 20,
  });
  // A parked, refunded duplicate is not "the" payment for the booking.
  const paid = rows.find((p) => PAID_PAYMENT_STATUSES.includes(p.status) && p.reviewReason !== "DUPLICATE_PAYMENT");
  const review = rows.find((p) => p.status === "REQUIRES_REVIEW");
  const open = rows.find((p) => OPEN_PAYMENT_STATUSES.includes(p.status));

  let state: "UNPAID" | "IN_PROGRESS" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "UNDER_REVIEW" = "UNPAID";
  if (paid) state = paid.status === "SUCCEEDED" ? "PAID" : (paid.status as "PARTIALLY_REFUNDED" | "REFUNDED");
  else if (review) state = "UNDER_REVIEW";
  else if (open) state = "IN_PROGRESS";

  if (viewer === "WORKER") return { state: state === "PAID" || state === "PARTIALLY_REFUNDED" ? ("PAID" as const) : state === "REFUNDED" ? ("REFUNDED" as const) : ("UNPAID" as const) };

  const canPay =
    PAYABLE_BOOKING_STATUSES.includes(booking.status) &&
    booking.agreedAmountBdt !== null &&
    booking.agreedAmountBdt > 0 &&
    booking.currency === "BDT" &&
    !paid && !review && !open;

  return {
    state,
    canPay,
    amountBdt: booking.agreedAmountBdt,
    currency: booking.currency,
    activeReference: open?.reference ?? null,
    payments: rows.slice(0, 10).map((p) => presentPayment(p)),
  };
}
