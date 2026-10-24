import { z } from "zod";
import { MAX_PAGE_SIZE } from "../workers/workers.schema.js";
import { nullableUserText, optionalUserText } from "../common/user-text.js";

export const REVIEW_COMMENT_MAX = 1000;
/** The author may edit within this many days of posting (policy: docs/COMMUNITY.md). */
export const REVIEW_EDIT_WINDOW_DAYS = 14;

const rating = z.number("Rating is required").int("Rating must be a whole number").min(1, "Rating must be 1 to 5").max(5, "Rating must be 1 to 5");

/** `strictObject`: author, worker, booking, status, "verified" flags etc. are rejected, never ignored. */
export const createReviewSchema = z.strictObject({
  rating,
  comment: optionalUserText(REVIEW_COMMENT_MAX, "Review"),
});
export type CreateReview = z.infer<typeof createReviewSchema>;

export const updateReviewSchema = z
  .strictObject({ rating: rating.optional(), comment: nullableUserText(REVIEW_COMMENT_MAX, "Review") })
  .refine((v) => v.rating !== undefined || v.comment !== undefined, { message: "Nothing to change" });
export type UpdateReview = z.infer<typeof updateReviewSchema>;

export const reviewListQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});
