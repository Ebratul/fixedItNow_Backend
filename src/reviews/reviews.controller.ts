import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  createReviewSchema,
  reviewListQuery,
  updateReviewSchema,
  type CreateReview,
  type UpdateReview,
} from "./reviews.schemas.js";
import { ReviewsService } from "./reviews.service.js";

@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** The review is addressed through its BOOKING, so there is no review id to guess. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("bookings/:id/review")
  create(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(createReviewSchema)) body: CreateReview,
  ) {
    return this.reviews.create(auth, id, body);
  }

  @Get("bookings/:id/review")
  mine(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.reviews.mine(auth, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put("bookings/:id/review")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateReviewSchema)) body: UpdateReview,
  ) {
    return this.reviews.update(auth, id, body);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Delete("bookings/:id/review")
  @HttpCode(200)
  withdraw(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.reviews.withdraw(auth, id);
  }

  /** Public; never returns per-viewer data. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("workers/:slug/reviews")
  forWorker(@Param("slug") slug: string, @Query(new ZodPipe(reviewListQuery)) query: { page: number; pageSize: number }) {
    return this.reviews.listForWorker(slug, query.page, query.pageSize);
  }
}
