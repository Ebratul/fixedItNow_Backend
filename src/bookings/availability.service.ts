import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";
import {
  BOOKING_TIMEZONE,
  MAX_ADVANCE_DAYS,
  MAX_TIME_OFF_DAYS,
  MIN_LEAD_MINUTES,
  SLOT_MINUTES,
} from "./booking.config.js";
import { SLOT_HOLDING_STATUSES } from "./booking.state.js";
import { Clock } from "./clock.js";
import { conflict, unprocessable } from "./domain-errors.js";
import { addDays, addMinutes, isOnGrid, localInstant, localParts, overlaps, weekdayOf } from "./time.js";

export type Db = PrismaService | Prisma.TransactionClient;
type Rule = { weekday: number; startMinute: number; endMinute: number };

export type BookableOptions = {
  now: Date;
  /** A new request must start this far ahead; at confirmation we only need "still in the future". */
  minLeadMinutes?: number;
  /** Ignore this booking's own reservation (reschedule). */
  excludeBookingId?: string;
};

/** Serialise schedule changes for one worker (belt and braces next to the DB exclusion constraint). */
export async function lockWorker(tx: Prisma.TransactionClient, workerProfileId: string) {
  await tx.$queryRaw`SELECT id FROM worker_profile WHERE id = ${workerProfileId} FOR UPDATE`;
}

/** Does [start, end) sit entirely inside one weekly window on one Dhaka calendar day? */
export function fitsRules(rules: Rule[], start: Date, end: Date): boolean {
  const s = localParts(start);
  const e = localParts(end);
  const endsAtMidnight = e.minuteOfDay === 0 && e.dateKey === addDays(s.dateKey, 1);
  if (e.dateKey !== s.dateKey && !endsAtMidnight) return false;
  const endMinute = endsAtMidnight ? 1440 : e.minuteOfDay;
  return rules.some((r) => r.weekday === s.weekday && r.startMinute <= s.minuteOfDay && endMinute <= r.endMinute);
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- weekly rules

  async getForWorker(workerProfileId: string) {
    const [rules, timeOff] = await Promise.all([
      this.prisma.workerAvailabilityRule.findMany({
        where: { workerProfileId },
        orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
        select: { id: true, weekday: true, startMinute: true, endMinute: true },
      }),
      this.prisma.workerTimeOff.findMany({
        where: { workerProfileId, endAt: { gt: this.clock.now() } },
        orderBy: { startAt: "asc" },
        take: 100,
        select: { id: true, startAt: true, endAt: true, note: true },
      }),
    ]);
    return { timezone: BOOKING_TIMEZONE, rules, timeOff };
  }

  /**
   * Replace the whole weekly schedule. Existing confirmed bookings are NOT
   * cancelled by a schedule change; the schedule only gates NEW bookings and
   * reschedules.
   */
  async replaceRules(workerProfileId: string, rules: Rule[]) {
    await this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, workerProfileId);
      await tx.workerAvailabilityRule.deleteMany({ where: { workerProfileId } });
      if (rules.length > 0) {
        await tx.workerAvailabilityRule.createMany({ data: rules.map((r) => ({ ...r, workerProfileId })) });
      }
    });
    return this.getForWorker(workerProfileId);
  }

  // ---------------------------------------------------------------- time off

  async addTimeOff(workerProfileId: string, startAt: Date, endAt: Date, note: string | null | undefined) {
    const now = this.clock.now();
    if (endAt <= now) throw unprocessable("TIME_OFF_IN_PAST", "Time off must end in the future");
    if (endAt.getTime() - startAt.getTime() > MAX_TIME_OFF_DAYS * 86_400_000) {
      throw unprocessable("TIME_OFF_TOO_LONG", `Time off can be at most ${MAX_TIME_OFF_DAYS} days`);
    }
    return this.prisma.$transaction(async (tx) => {
      await lockWorker(tx, workerProfileId);
      const clash = await tx.booking.findFirst({
        where: {
          workerProfileId,
          status: { in: SLOT_HOLDING_STATUSES },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { id: true },
      });
      if (clash) {
        throw conflict(
          "TIME_OFF_CLASHES_WITH_BOOKING",
          "You have a confirmed booking in that period. Reschedule or cancel it first.",
        );
      }
      return tx.workerTimeOff.create({
        data: { workerProfileId, startAt, endAt, note: note ?? null },
        select: { id: true, startAt: true, endAt: true, note: true },
      });
    });
  }

  /** Only the owner's own entry can be removed (scoped by workerProfileId). */
  async removeTimeOff(workerProfileId: string, id: string) {
    const result = await this.prisma.workerTimeOff.deleteMany({ where: { id, workerProfileId } });
    return { removed: result.count > 0 };
  }

  // ---------------------------------------------------------------- bookability

  /**
   * Is [start, end) a valid appointment for this worker right now? Applies, in
   * order: grid alignment, lead time/horizon, weekly rules, time off, and
   * existing reservations. Throws 422 for rule violations and 409 when the
   * slot is taken. Run inside the worker lock for authoritative checks.
   */
  async assertBookable(db: Db, workerProfileId: string, start: Date, end: Date, options: BookableOptions) {
    const { now, minLeadMinutes = MIN_LEAD_MINUTES, excludeBookingId } = options;
    if (!isOnGrid(start) || !isOnGrid(end)) {
      throw unprocessable("MISALIGNED_TIME", `Appointments must start and end on ${SLOT_MINUTES}-minute marks`);
    }
    if (start.getTime() < addMinutes(now, minLeadMinutes).getTime()) {
      throw unprocessable(
        "TOO_SOON",
        minLeadMinutes > 0
          ? "That time is too soon or in the past. Choose a later time."
          : "That appointment time has already passed.",
      );
    }
    if (start.getTime() > now.getTime() + MAX_ADVANCE_DAYS * 86_400_000) {
      throw unprocessable("TOO_FAR_AHEAD", `Appointments can be booked up to ${MAX_ADVANCE_DAYS} days ahead`);
    }

    const rules = await db.workerAvailabilityRule.findMany({
      where: { workerProfileId },
      select: { weekday: true, startMinute: true, endMinute: true },
    });
    if (!fitsRules(rules, start, end)) {
      throw unprocessable("OUTSIDE_AVAILABILITY", "That time is outside this professional's working hours");
    }

    const timeOff = await db.workerTimeOff.findFirst({
      where: { workerProfileId, startAt: { lt: end }, endAt: { gt: start } },
      select: { id: true },
    });
    if (timeOff) throw unprocessable("TIME_OFF", "This professional is unavailable at that time");

    const taken = await db.booking.findFirst({
      where: {
        workerProfileId,
        status: { in: SLOT_HOLDING_STATUSES },
        startAt: { lt: end },
        endAt: { gt: start },
        ...(excludeBookingId && { id: { not: excludeBookingId } }),
      },
      select: { id: true },
    });
    if (taken) throw conflict("SLOT_UNAVAILABLE", "That time slot is no longer available");
  }

  // ---------------------------------------------------------------- public slots

  /**
   * Public: start times a customer could request, by Dhaka calendar day.
   * Reveals availability only (no booking details). Customer-agnostic.
   */
  async publicSlots(slug: string, from: string | undefined, days: number, durationMinutes: number) {
    const worker = await this.prisma.workerProfile.findFirst({
      where: { ...ELIGIBLE_WORKER, slug },
      select: { id: true },
    });
    if (!worker) return undefined;

    const now = this.clock.now();
    const firstDay = from ?? localParts(now).dateKey;
    const lastDay = addDays(firstDay, days - 1);
    const rangeStart = localInstant(firstDay, 0);
    const rangeEnd = localInstant(addDays(lastDay, 1), 0);

    const [rules, timeOff, bookings] = await Promise.all([
      this.prisma.workerAvailabilityRule.findMany({
        where: { workerProfileId: worker.id },
        select: { weekday: true, startMinute: true, endMinute: true },
      }),
      this.prisma.workerTimeOff.findMany({
        where: { workerProfileId: worker.id, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
        select: { startAt: true, endAt: true },
      }),
      this.prisma.booking.findMany({
        where: {
          workerProfileId: worker.id,
          status: { in: SLOT_HOLDING_STATUSES },
          startAt: { lt: rangeEnd },
          endAt: { gt: rangeStart },
        },
        select: { startAt: true, endAt: true },
      }),
    ]);

    const earliest = addMinutes(now, MIN_LEAD_MINUTES);
    const latest = new Date(now.getTime() + MAX_ADVANCE_DAYS * 86_400_000);
    const busy = [...timeOff, ...bookings];

    const result: { date: string; slots: string[] }[] = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(firstDay, i);
      const slots: string[] = [];
      for (const rule of rules.filter((r) => r.weekday === weekdayOf(date))) {
        for (let m = rule.startMinute; m + durationMinutes <= rule.endMinute; m += SLOT_MINUTES) {
          const start = localInstant(date, m);
          const end = addMinutes(start, durationMinutes);
          if (start < earliest || start > latest) continue;
          if (busy.some((b) => overlaps(start, end, b.startAt, b.endAt))) continue;
          slots.push(start.toISOString());
        }
      }
      result.push({ date, slots: slots.sort() });
    }
    return {
      timezone: BOOKING_TIMEZONE,
      durationMinutes,
      acceptingBookings: rules.length > 0,
      days: result,
    };
  }
}
