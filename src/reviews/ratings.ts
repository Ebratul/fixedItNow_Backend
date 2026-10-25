import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma/prisma.service.js";

type Db = PrismaService | Prisma.TransactionClient;

export type RatingSummary = { rating: number | null; reviewCount: number };
export const NO_REVIEWS: RatingSummary = { rating: null, reviewCount: 0 };

/**
 * Payment states that make a booking REVIEWABLE and its review COUNTED: the customer's payment was verified
 * by the provider and the money has not been fully given back. (PARTIALLY_REFUNDED still counts: the job
 * happened and was paid for; REFUNDED does not; REQUIRES_REVIEW and every unpaid state never do.)
 */
export const REVIEWABLE_PAYMENT_STATUSES = ["SUCCEEDED", "PARTIALLY_REFUNDED"] as const;

/**
 * WHICH REVIEWS COUNT. One definition, used by every rating shown anywhere
 * (cards, profile, reviews list, AI assistant):
 *   - the review is VISIBLE (not hidden by an admin, not withdrawn by its author), AND
 *   - its booking is currently COMPLETED, AND
 *   - that booking has a provider-verified payment (REVIEWABLE_PAYMENT_STATUSES).
 * If a dispute moves the booking away from COMPLETED, or the payment is fully refunded, the review is not
 * counted (and not shown as verified) until the booking qualifies again.
 */
export const COUNTED_REVIEW = {
  status: "VISIBLE",
  booking: { status: "COMPLETED", payments: { some: { status: { in: [...REVIEWABLE_PAYMENT_STATUSES] } } } },
} as const satisfies Prisma.ReviewWhereInput;

/** Can the customer review this booking right now? (Their ownership is checked separately.) */
export async function isReviewable(db: Db, booking: { id: string; status: string }): Promise<boolean> {
  if (booking.status !== "COMPLETED") return false;
  const paid = await db.payment.count({ where: { bookingId: booking.id, status: { in: [...REVIEWABLE_PAYMENT_STATUSES] } }, take: 1 });
  return paid > 0;
}

/** Average to one decimal, halves rounded up. Display policy: "4.3". */
export function roundRating(average: number): number {
  return Math.round(average * 10) / 10;
}

/** Ratings for many workers in ONE grouped query (no N+1). Workers with no counted review are absent from the map. */
export async function ratingSummaries(db: Db, workerProfileIds: string[]): Promise<Map<string, RatingSummary>> {
  const ids = [...new Set(workerProfileIds)];
  const out = new Map<string, RatingSummary>();
  if (ids.length === 0) return out;
  const rows = await db.review.groupBy({
    by: ["workerProfileId"],
    where: { workerProfileId: { in: ids }, ...COUNTED_REVIEW },
    _avg: { rating: true },
    _count: { _all: true },
  });
  for (const row of rows) {
    out.set(row.workerProfileId, {
      rating: row._avg.rating === null ? null : roundRating(row._avg.rating),
      reviewCount: row._count._all,
    });
  }
  return out;
}

/** 1..5 -> number of counted reviews, for the profile's rating breakdown. */
export async function ratingDistribution(db: Db, workerProfileId: string): Promise<Record<"1" | "2" | "3" | "4" | "5", number>> {
  const rows = await db.review.groupBy({
    by: ["rating"],
    where: { workerProfileId, ...COUNTED_REVIEW },
    _count: { _all: true },
  });
  const out = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const row of rows) out[String(row.rating) as keyof typeof out] = row._count._all;
  return out;
}
