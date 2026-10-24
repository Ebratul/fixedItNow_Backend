import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { AvailabilityService } from "./availability.service.js";
import { addMinutes } from "./time.js";
import { BookingCore, effectiveStatus } from "./booking-core.service.js";
import type { QuoteInput } from "./booking.schemas.js";
import { BookingsService } from "./bookings.service.js";
import { conflict, isUniqueViolation, unprocessable } from "./domain-errors.js";
import { NotFoundException } from "@nestjs/common";

/**
 * Quotes. All amounts are whole BDT integers; the total is computed here, never
 * accepted from the client. An accepted quote is immutable: a "revision" is a
 * NEW quote that supersedes (withdraws) the previous pending one, and every
 * version stays in the table as history.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly core: BookingCore,
    private readonly bookings: BookingsService,
    private readonly availability: AvailabilityService,
  ) {}

  /** Worker sends a quote, or revises their pending one. */
  create(auth: AuthContext, bookingId: string, input: QuoteInput) {
    return this.bookings.act(auth, bookingId, "WORKER", async (tx, { booking }, now) => {
      if (booking.pricingModel !== "QUOTE") {
        throw unprocessable("QUOTE_NOT_ALLOWED", "This service has a fixed or hourly price. Accept the request instead.");
      }
      if (booking.status !== "REQUESTED" && booking.status !== "QUOTED") {
        throw conflict("INVALID_TRANSITION", `Cannot quote a booking that is ${effectiveStatus(booking, now)}`);
      }
      this.core.assertWorkerStillEligible(booking);

      const total = input.laborBdt + input.materialsBdt + input.otherBdt; // server-side total
      const validUntil = addMinutes(now, input.validForHours * 60);
      const expiresAt = validUntil < booking.startAt ? validUntil : booking.startAt;

      // Supersede the previous pending quote (kept as WITHDRAWN history).
      await tx.quote.updateMany({
        where: { bookingId: booking.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
      let quoteId: string;
      try {
        const quote = await tx.quote.create({
          data: {
            bookingId: booking.id,
            laborBdt: input.laborBdt,
            materialsBdt: input.materialsBdt,
            otherBdt: input.otherBdt,
            totalBdt: total,
            description: input.description,
            terms: input.terms ?? null,
            estimatedDurationMinutes: input.estimatedDurationMinutes ?? null,
            expiresAt,
            createdByUserId: auth.userId,
          },
          select: { id: true },
        });
        quoteId = quote.id;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("QUOTE_PENDING", "A quote is already being sent. Refresh and try again.");
        throw error;
      }
      await this.core.transition(tx, booking, "quote", { userId: auth.userId, role: "WORKER" }, {
        eventType: booking.status === "QUOTED" ? "quote.revised" : "quote.sent",
        metadata: { quoteId, totalBdt: total },
      });
    });
  }

  private async loadQuote(tx: Parameters<Parameters<BookingsService["act"]>[3]>[0], bookingId: string, quoteId: string) {
    // The quote must belong to THIS booking: another booking's quote id is a 404.
    const quote = await tx.quote.findFirst({ where: { id: quoteId, bookingId } });
    if (!quote) throw new NotFoundException("Quote not found");
    return quote;
  }

  /** Customer accepts: validates, then atomically accepts the quote and CONFIRMS the booking. */
  accept(auth: AuthContext, bookingId: string, quoteId: string, expectedTotalBdt?: number) {
    return this.bookings.act(auth, bookingId, "CUSTOMER", async (tx, { booking }, now) => {
      const quote = await this.loadQuote(tx, bookingId, quoteId);
      if (quote.status === "EXPIRED" || (quote.status === "PENDING" && quote.expiresAt <= now)) {
        throw conflict("QUOTE_EXPIRED", "This quote has expired. Ask the professional for a new one.");
      }
      if (quote.status !== "PENDING") {
        throw conflict("QUOTE_NOT_PENDING", `This quote is ${quote.status.toLowerCase()} and can no longer be accepted`);
      }
      if (expectedTotalBdt !== undefined && expectedTotalBdt !== quote.totalBdt) {
        throw conflict("QUOTE_CHANGED", "The quote changed since you opened it. Review the new amount.");
      }
      if (booking.status !== "QUOTED") {
        throw conflict("INVALID_TRANSITION", `Cannot accept a quote on a booking that is ${effectiveStatus(booking, now)}`);
      }
      this.core.assertWorkerStillEligible(booking);
      await this.availability.assertBookable(tx, booking.workerProfileId, booking.startAt, booking.endAt, {
        now,
        minLeadMinutes: 0,
        excludeBookingId: booking.id,
      });
      // Conditional on PENDING: a concurrent accept/withdraw makes this affect 0 rows.
      const accepted = await tx.quote.updateMany({
        where: { id: quote.id, bookingId, status: "PENDING" },
        data: { status: "ACCEPTED", decidedAt: now },
      });
      if (accepted.count === 0) throw conflict("QUOTE_NOT_PENDING", "This quote can no longer be accepted");
      await this.core.transition(tx, booking, "accept_quote", { userId: auth.userId, role: "CUSTOMER" }, {
        // The price comes from the STORED quote, never from the request.
        data: { agreedAmountBdt: quote.totalBdt, acceptedQuoteId: quote.id, confirmedAt: now },
        eventType: "quote.accepted",
        metadata: { quoteId: quote.id, agreedAmountBdt: quote.totalBdt },
      });
    });
  }

  reject(auth: AuthContext, bookingId: string, quoteId: string, reason?: string) {
    return this.bookings.act(auth, bookingId, "CUSTOMER", async (tx, { booking }, now) => {
      const quote = await this.loadQuote(tx, bookingId, quoteId);
      if (quote.status !== "PENDING" || quote.expiresAt <= now) {
        throw conflict("QUOTE_NOT_PENDING", "This quote can no longer be rejected");
      }
      const done = await tx.quote.updateMany({
        where: { id: quote.id, status: "PENDING" },
        data: { status: "REJECTED", decidedAt: now },
      });
      if (done.count === 0) throw conflict("QUOTE_NOT_PENDING", "This quote can no longer be rejected");
      await this.core.transition(tx, booking, "reject_quote", { userId: auth.userId, role: "CUSTOMER" }, {
        eventType: "quote.rejected",
        reason,
        metadata: { quoteId: quote.id },
      });
    });
  }

  withdraw(auth: AuthContext, bookingId: string, quoteId: string) {
    return this.bookings.act(auth, bookingId, "WORKER", async (tx, { booking }, now) => {
      const quote = await this.loadQuote(tx, bookingId, quoteId);
      if (quote.status !== "PENDING") throw conflict("QUOTE_NOT_PENDING", "Only a pending quote can be withdrawn");
      const done = await tx.quote.updateMany({
        where: { id: quote.id, status: "PENDING" },
        data: { status: "WITHDRAWN", decidedAt: now },
      });
      if (done.count === 0) throw conflict("QUOTE_NOT_PENDING", "Only a pending quote can be withdrawn");
      await this.core.transition(tx, booking, "withdraw_quote", { userId: auth.userId, role: "WORKER" }, {
        eventType: "quote.withdrawn",
        metadata: { quoteId: quote.id },
      });
    });
  }
}
