import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { AvailabilityService } from "./availability.service.js";
import { RESCHEDULE_VALID_HOURS } from "./booking.config.js";
import { BookingCore } from "./booking-core.service.js";
import { BookingsService } from "./bookings.service.js";
import { conflict, isExclusionViolation, isUniqueViolation, unprocessable } from "./domain-errors.js";
import { addMinutes } from "./time.js";

/**
 * Rescheduling is request-and-approval. Only a CONFIRMED booking can be
 * rescheduled; the duration never changes (so the agreed price stays valid).
 * The ORIGINAL appointment stays reserved until the other party accepts, and the
 * swap is re-validated and applied atomically under the worker lock; the DB
 * exclusion constraint is the final backstop against a double booking.
 */
@Injectable()
export class RescheduleService {
  constructor(
    private readonly core: BookingCore,
    private readonly bookings: BookingsService,
    private readonly availability: AvailabilityService,
  ) {}

  request(auth: AuthContext, bookingId: string, newStartAt: Date, reason?: string) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }, now) => {
      if (booking.status !== "CONFIRMED") {
        throw conflict("INVALID_TRANSITION", `Only confirmed bookings can be rescheduled (this one is ${booking.status.toLowerCase()})`);
      }
      if (newStartAt.getTime() === booking.startAt.getTime()) {
        throw unprocessable("SAME_TIME", "Choose a different time");
      }
      const newEndAt = addMinutes(newStartAt, booking.durationMinutes);
      // Preliminary check; re-run authoritatively when the other party accepts.
      await this.availability.assertBookable(tx, booking.workerProfileId, newStartAt, newEndAt, {
        now,
        excludeBookingId: booking.id,
      });
      const expiresAt = new Date(Math.min(addMinutes(now, RESCHEDULE_VALID_HOURS * 60).getTime(), booking.startAt.getTime()));
      try {
        await tx.rescheduleRequest.create({
          data: {
            bookingId: booking.id,
            requestedByUserId: auth.userId,
            requestedByRole: viewer,
            previousStartAt: booking.startAt,
            previousEndAt: booking.endAt,
            newStartAt,
            newEndAt,
            reason: reason ?? null,
            expiresAt,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("RESCHEDULE_PENDING", "There is already a reschedule request waiting for a response");
        }
        throw error;
      }
      await this.core.event(tx, booking.id, { userId: auth.userId, role: viewer }, "reschedule.requested", {
        reason,
        metadata: { newStartAt: newStartAt.toISOString() },
      });
    });
  }

  private async loadRequest(tx: Parameters<Parameters<BookingsService["act"]>[3]>[0], bookingId: string, id: string) {
    const request = await tx.rescheduleRequest.findFirst({ where: { id, bookingId } });
    if (!request) throw new NotFoundException("Reschedule request not found");
    return request;
  }

  /** The OTHER participant approves. */
  accept(auth: AuthContext, bookingId: string, requestId: string) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }, now) => {
      const request = await this.loadRequest(tx, bookingId, requestId);
      if (request.status !== "PENDING" || request.expiresAt <= now) {
        throw conflict("RESCHEDULE_NOT_PENDING", "This reschedule request is no longer open");
      }
      if (request.requestedByUserId === auth.userId || request.requestedByRole === viewer) {
        throw conflict("OWN_REQUEST", "The other party must respond to your request");
      }
      if (booking.status !== "CONFIRMED") {
        throw conflict("INVALID_TRANSITION", "Only a confirmed booking can be rescheduled");
      }
      await this.availability.assertBookable(tx, booking.workerProfileId, request.newStartAt, request.newEndAt, {
        now,
        minLeadMinutes: 0,
        excludeBookingId: booking.id,
      });
      try {
        const moved = await tx.booking.updateMany({
          where: { id: booking.id, status: "CONFIRMED", startAt: request.previousStartAt },
          data: { startAt: request.newStartAt, endAt: request.newEndAt },
        });
        if (moved.count === 0) throw conflict("STALE_BOOKING", "This booking just changed. Refresh and try again.");
      } catch (error) {
        if (isExclusionViolation(error)) throw conflict("SLOT_UNAVAILABLE", "That time slot is no longer available");
        throw error;
      }
      await tx.rescheduleRequest.update({
        where: { id: request.id },
        data: { status: "ACCEPTED", decidedByUserId: auth.userId, decidedAt: now },
      });
      await this.core.event(tx, booking.id, { userId: auth.userId, role: viewer }, "reschedule.accepted", {
        metadata: {
          from: request.previousStartAt.toISOString(),
          to: request.newStartAt.toISOString(),
        },
      });
    });
  }

  reject(auth: AuthContext, bookingId: string, requestId: string, reason?: string) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }, now) => {
      const request = await this.loadRequest(tx, bookingId, requestId);
      if (request.status !== "PENDING" || request.expiresAt <= now) {
        throw conflict("RESCHEDULE_NOT_PENDING", "This reschedule request is no longer open");
      }
      if (request.requestedByRole === viewer) {
        throw conflict("OWN_REQUEST", "Use withdraw to cancel your own request");
      }
      await tx.rescheduleRequest.update({
        where: { id: request.id },
        data: { status: "REJECTED", decidedByUserId: auth.userId, decidedAt: now },
      });
      // The original appointment is untouched.
      await this.core.event(tx, booking.id, { userId: auth.userId, role: viewer }, "reschedule.rejected", { reason });
    });
  }

  withdraw(auth: AuthContext, bookingId: string, requestId: string) {
    return this.bookings.act(auth, bookingId, null, async (tx, { booking, viewer }, now) => {
      const request = await this.loadRequest(tx, bookingId, requestId);
      if (request.status !== "PENDING" || request.expiresAt <= now) {
        throw conflict("RESCHEDULE_NOT_PENDING", "This reschedule request is no longer open");
      }
      if (request.requestedByRole !== viewer) {
        throw conflict("NOT_YOUR_REQUEST", "Only the person who asked can withdraw the request");
      }
      await tx.rescheduleRequest.update({
        where: { id: request.id },
        data: { status: "WITHDRAWN", decidedByUserId: auth.userId, decidedAt: now },
      });
      await this.core.event(tx, booking.id, { userId: auth.userId, role: viewer }, "reschedule.withdrawn");
    });
  }
}
