import { BOOKING_TIMEZONE, SLOT_MINUTES } from "./booking.config.js";

/**
 * Bangladesh has no daylight-saving time (Asia/Dhaka is UTC+06:00 year-round
 * since 2009), so converting a local wall-clock time to an instant is a fixed
 * offset. Reading an instant back uses Intl, so a future tz-rule change would
 * surface in the round-trip unit test rather than silently.
 */
const OFFSET_MS = 6 * 60 * 60 * 1000;

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BOOKING_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type LocalParts = {
  dateKey: string; // YYYY-MM-DD in Asia/Dhaka
  weekday: number; // 0 = Sunday
  minuteOfDay: number;
  second: number;
};

export function localParts(instant: Date): LocalParts {
  const p = Object.fromEntries(formatter.formatToParts(instant).map((x) => [x.type, x.value]));
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS.indexOf(p.weekday),
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute),
    second: Number(p.second),
  };
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: string): boolean {
  const m = DATE_KEY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** The instant at `minuteOfDay` (0-1440) on a Dhaka calendar date. */
export function localInstant(dateKey: string, minuteOfDay: number): Date {
  const m = DATE_KEY.exec(dateKey)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minuteOfDay) - OFFSET_MS);
}

export function addDays(dateKey: string, days: number): string {
  const m = DATE_KEY.exec(dateKey)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Calendar weekday of a date key (0 = Sunday); independent of time zones. */
export function weekdayOf(dateKey: string): number {
  const m = DATE_KEY.exec(dateKey)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** True when the instant is on the slot grid (whole 30-minute marks, zero seconds). */
export function isOnGrid(instant: Date): boolean {
  if (instant.getUTCMilliseconds() !== 0) return false;
  const { minuteOfDay, second } = localParts(instant);
  return second === 0 && minuteOfDay % SLOT_MINUTES === 0;
}

export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

/** Half-open interval overlap: [aStart, aEnd) vs [bStart, bEnd). */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
