import type { BookingStatus, Prisma } from "../generated/prisma/client.js";
import { isReviewable } from "./ratings.js";
import { REVIEW_EDIT_WINDOW_DAYS } from "./reviews.schemas.js";

type Booking = { id: string; status: BookingStatus };

/** Review part of the booking detail, for the viewer's side. */
export async function reviewSummary(tx: Prisma.TransactionClient, booking: Booking, viewer: "CUSTOMER" | "WORKER", now: Date) {
  const row = await tx.review.findUnique({
    where: { bookingId: booking.id },
    select: { id: true, rating: true, comment: true, status: true, createdAt: true, editedAt: true },
  });
  const reviewable = await isReviewable(tx, booking);
  if (viewer === "WORKER") {
    // The professional sees a review only while it is publicly visible and counted.
    const shown = row && row.status === "VISIBLE" && reviewable ? row : null;
    return { review: shown ? { rating: shown.rating, comment: shown.comment, createdAt: shown.createdAt } : null };
  }
  const editableUntil = row ? new Date(row.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 86_400_000) : null;
  return {
    // Reviewable = completed AND a verified payment exists; never decided by the client.
    canReview: reviewable && row === null,
    review: row
      ? {
          id: row.id,
          rating: row.rating,
          comment: row.comment,
          status: row.status,
          createdAt: row.createdAt,
          editedAt: row.editedAt,
          canEdit: row.status === "VISIBLE" && editableUntil !== null && now <= editableUntil,
          canWithdraw: row.status === "VISIBLE",
          editableUntil,
        }
      : null,
  };
}
