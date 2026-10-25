import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Clock } from "../bookings/clock.js";
import { bookingNotFound, conflict, isUniqueViolation, unprocessable } from "../bookings/domain-errors.js";
import type { AuthContext } from "../auth/auth.types.js";
import { authorSelect, publicName } from "../common/user-text.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";
import { isValidSlug } from "../workers/slug.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { COUNTED_REVIEW, isReviewable, ratingDistribution, ratingSummaries, NO_REVIEWS } from "./ratings.js";
import { REVIEW_EDIT_WINDOW_DAYS, type CreateReview, type UpdateReview } from "./reviews.schemas.js";

/** Review as its own author sees it. */
function present(r: { id: string; bookingId: string; rating: number; comment: string | null; status: string; createdAt: Date; editedAt: Date | null }, now: Date) {
  const editableUntil = new Date(r.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 86_400_000);
  return {
    id: r.id,
    bookingId: r.bookingId,
    rating: r.rating,
    comment: r.comment,
    status: r.status,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    editableUntil,
    canEdit: r.status === "VISIBLE" && now <= editableUntil,
    canWithdraw: r.status === "VISIBLE",
  };
}

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Eligibility is decided HERE, from the database, never from the request:
   * the caller must be the booking's customer, the booking must be COMPLETED, and a payment for it must have
   * been VERIFIED by the provider (a redirect or a customer click never counts). A booking that is not yours is indistinguishable from one that does not
   * exist (404). One review per booking is enforced by a UNIQUE constraint, so
   * parallel submissions create exactly one row.
   */
  async create(auth: AuthContext, bookingId: string, input: CreateReview) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, customerId: true, status: true, workerProfileId: true, workerProfile: { select: { userId: true } }, category: { select: { name: true } } },
    });
    if (!booking || booking.customerId !== auth.userId) throw bookingNotFound();
    if (booking.workerProfile.userId === auth.userId) {
      throw new ForbiddenException("You cannot review your own service");
    }
    if (booking.status !== "COMPLETED") {
      throw unprocessable("BOOKING_NOT_REVIEWABLE", "You can review a booking once the job is completed and paid");
    }
    if (!(await isReviewable(this.prisma, booking))) {
      throw unprocessable("PAYMENT_NOT_VERIFIED", "You can review this booking once its payment has been verified");
    }
    const now = this.clock.now();
    try {
      const row = await this.prisma.review.create({
        data: {
          // Stamped from the injectable clock so the edit window is testable.
          createdAt: now,
          bookingId: booking.id,
          customerId: auth.userId,
          workerProfileId: booking.workerProfileId,
          rating: input.rating,
          comment: input.comment ?? null,
        },
      });
      await this.notifications.notifyBestEffort([
        {
          userId: booking.workerProfile.userId,
          type: "review.received",
          title: "You received a review",
          body: `A customer rated your ${booking.category.name} job ${input.rating} out of 5.`,
          link: `/bookings/${booking.id}`,
        },
      ]);
      return { review: present(row, now) };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("REVIEW_EXISTS", "You have already reviewed this booking");
      throw error;
    }
  }

  async mine(auth: AuthContext, bookingId: string) {
    const row = await this.prisma.review.findFirst({ where: { bookingId, customerId: auth.userId } });
    if (!row) throw new NotFoundException("Review not found");
    return { review: present(row, this.clock.now()) };
  }

  /**
   * Edit within REVIEW_EDIT_WINDOW_DAYS of posting, only while VISIBLE (a review
   * hidden by an administrator cannot be rewritten to dodge moderation). Each
   * edit stores the previous text in review_revision, so edits are accountable.
   */
  async update(auth: AuthContext, bookingId: string, input: UpdateReview) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findFirst({ where: { bookingId, customerId: auth.userId } });
      if (!review) throw new NotFoundException("Review not found");
      const now = this.clock.now();
      if (review.status !== "VISIBLE") throw conflict("REVIEW_NOT_EDITABLE", "This review can no longer be edited");
      if (now.getTime() > review.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 86_400_000) {
        throw unprocessable("EDIT_WINDOW_CLOSED", `Reviews can be edited for ${REVIEW_EDIT_WINDOW_DAYS} days after posting`);
      }
      const rating = input.rating ?? review.rating;
      const comment = input.comment === undefined ? review.comment : input.comment ?? null;
      if (rating === review.rating && comment === review.comment) return { review: present(review, now) };

      await tx.reviewRevision.create({ data: { reviewId: review.id, rating: review.rating, comment: review.comment } });
      const { count } = await tx.review.updateMany({
        where: { id: review.id, status: "VISIBLE" },
        data: { rating, comment, editedAt: now },
      });
      if (count === 0) throw conflict("REVIEW_NOT_EDITABLE", "This review can no longer be edited");
      const updated = await tx.review.findUniqueOrThrow({ where: { id: review.id } });
      return { review: present(updated, now) };
    });
  }

  /** The author withdraws their review: final (it can be neither edited nor re-posted), idempotent. */
  async withdraw(auth: AuthContext, bookingId: string) {
    const review = await this.prisma.review.findFirst({ where: { bookingId, customerId: auth.userId } });
    if (!review) throw new NotFoundException("Review not found");
    if (review.status === "DELETED") return { review: present(review, this.clock.now()) };
    if (review.status === "HIDDEN") throw conflict("REVIEW_NOT_EDITABLE", "This review is under moderation and cannot be changed");
    const { count } = await this.prisma.review.updateMany({ where: { id: review.id, status: "VISIBLE" }, data: { status: "DELETED" } });
    if (count === 0) throw conflict("REVIEW_NOT_EDITABLE", "This review is under moderation and cannot be changed");
    return { review: present({ ...review, status: "DELETED" }, this.clock.now()) };
  }

  /**
   * Public reviews of one listed professional. Only counted reviews appear
   * (visible + booking completed), so "Verified booking" is derived on the
   * server from that join and can never come from the client. Author = public
   * display name only.
   */
  async listForWorker(slug: string, page: number, pageSize: number) {
    if (!isValidSlug(slug)) throw new NotFoundException("Professional not found");
    const worker = await this.prisma.workerProfile.findFirst({ where: { ...ELIGIBLE_WORKER, slug }, select: { id: true } });
    if (!worker) throw new NotFoundException("Professional not found");
    const where = { workerProfileId: worker.id, ...COUNTED_REVIEW };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          editedAt: true,
          customer: { select: authorSelect },
          booking: { select: { category: { select: { name: true } } } },
        },
      }),
    ]);
    const summary = (await ratingSummaries(this.prisma, [worker.id])).get(worker.id) ?? NO_REVIEWS;
    return {
      summary: { ...summary, distribution: await ratingDistribution(this.prisma, worker.id) },
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        edited: r.editedAt !== null,
        author: { displayName: publicName(r.customer) },
        service: r.booking.category.name,
        verifiedBooking: true,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }
}
