import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  acceptQuoteSchema,
  createBookingSchema,
  disputeMessageSchema,
  disputeSchema,
  emptyBodySchema,
  listBookingsSchema,
  quoteSchema,
  reasonSchema,
  rescheduleSchema,
  type CreateBookingInput,
  type ListBookingsQuery,
  type QuoteInput,
} from "./booking.schemas.js";
import { BookingsService } from "./bookings.service.js";
import { DisputesService } from "./disputes.service.js";
import { QuotesService } from "./quotes.service.js";
import { RescheduleService } from "./reschedule.service.js";

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const uuid = () => new ParseUUIDPipe();

/**
 * Every route requires a session (global default-deny guard). Access to a
 * specific booking is then checked against that booking's participants; anyone
 * else gets the same 404 as for a non-existent id. No endpoint accepts a status.
 */
@Controller("bookings")
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly quotes: QuotesService,
    private readonly reschedules: RescheduleService,
    private readonly disputes: DisputesService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (key !== undefined && !KEY.test(key)) {
      throw new BadRequestException("Idempotency-Key must be 8-64 letters, digits, '-' or '_'");
    }
    const { created, ...result } = await this.bookings.create(auth, body, key);
    res.status(created ? 201 : 200);
    return result;
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listBookingsSchema)) query: ListBookingsQuery) {
    return this.bookings.list(auth, query);
  }

  @Get(":id")
  detail(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.bookings.detail(auth, id);
  }

  @Get(":id/history")
  history(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.bookings.history(auth, id);
  }

  // ---- worker / customer actions on the booking ----

  @Post(":id/accept")
  @HttpCode(200)
  accept(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.bookings.accept(auth, id);
  }

  @Post(":id/decline")
  @HttpCode(200)
  decline(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(reasonSchema)) body: { reason?: string }) {
    return this.bookings.decline(auth, id, body.reason);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  cancel(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(reasonSchema)) body: { reason?: string }) {
    return this.bookings.cancel(auth, id, body.reason);
  }

  @Post(":id/arrive")
  @HttpCode(200)
  arrive(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.bookings.arrive(auth, id);
  }

  @Post(":id/start")
  @HttpCode(200)
  start(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.bookings.start(auth, id);
  }

  @Post(":id/mark-finished")
  @HttpCode(200)
  markFinished(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.bookings.markFinished(auth, id);
  }

  @Post(":id/complete")
  @HttpCode(200)
  complete(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.bookings.complete(auth, id);
  }

  // ---- quotes ----

  @Post(":id/quotes")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  quote(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(quoteSchema)) body: QuoteInput) {
    return this.quotes.create(auth, id, body);
  }

  @Post(":id/quotes/:quoteId/accept")
  @HttpCode(200)
  acceptQuote(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("quoteId", uuid()) quoteId: string,
    @Body(new ZodPipe(acceptQuoteSchema)) body: { expectedTotalBdt?: number },
  ) {
    return this.quotes.accept(auth, id, quoteId, body.expectedTotalBdt);
  }

  @Post(":id/quotes/:quoteId/reject")
  @HttpCode(200)
  rejectQuote(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("quoteId", uuid()) quoteId: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason?: string },
  ) {
    return this.quotes.reject(auth, id, quoteId, body.reason);
  }

  @Post(":id/quotes/:quoteId/withdraw")
  @HttpCode(200)
  withdrawQuote(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("quoteId", uuid()) quoteId: string,
    @Body(new ZodPipe(emptyBodySchema)) _body: unknown,
  ) {
    return this.quotes.withdraw(auth, id, quoteId);
  }

  // ---- rescheduling ----

  @Post(":id/reschedule")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reschedule(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Body(new ZodPipe(rescheduleSchema)) body: { newStartAt: Date; reason?: string },
  ) {
    return this.reschedules.request(auth, id, body.newStartAt, body.reason);
  }

  @Post(":id/reschedule/:requestId/accept")
  @HttpCode(200)
  acceptReschedule(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("requestId", uuid()) requestId: string,
    @Body(new ZodPipe(emptyBodySchema)) _body: unknown,
  ) {
    return this.reschedules.accept(auth, id, requestId);
  }

  @Post(":id/reschedule/:requestId/reject")
  @HttpCode(200)
  rejectReschedule(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("requestId", uuid()) requestId: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason?: string },
  ) {
    return this.reschedules.reject(auth, id, requestId, body.reason);
  }

  @Post(":id/reschedule/:requestId/withdraw")
  @HttpCode(200)
  withdrawReschedule(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("requestId", uuid()) requestId: string,
    @Body(new ZodPipe(emptyBodySchema)) _body: unknown,
  ) {
    return this.reschedules.withdraw(auth, id, requestId);
  }

  // ---- disputes (participant side) ----

  @Post(":id/disputes")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  openDispute(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Body(new ZodPipe(disputeSchema)) body: Parameters<DisputesService["open"]>[2],
  ) {
    return this.disputes.open(auth, id, body);
  }

  @Get(":id/dispute")
  dispute(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.disputes.getForParticipant(auth, id);
  }

  @Post(":id/dispute/messages")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  disputeMessage(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Body(new ZodPipe(disputeMessageSchema)) body: { body: string },
  ) {
    return this.disputes.addMessage(auth, id, body.body);
  }

  @Post(":id/dispute/withdraw")
  @HttpCode(200)
  withdrawDispute(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(emptyBodySchema)) _body: unknown) {
    return this.disputes.withdraw(auth, id);
  }
}
