import { z } from "zod";
import { DIVISIONS } from "../common/constants.js";
import {
  MAX_AVAILABILITY_WINDOWS,
  MAX_DURATION_MINUTES,
  MAX_QUOTE_COMPONENT_BDT,
  MIN_DURATION_MINUTES,
  QUOTE_DEFAULT_VALID_HOURS,
  QUOTE_MAX_VALID_HOURS,
  SLOT_MINUTES,
} from "./booking.config.js";
import { isDateKey } from "./time.js";

/** ISO-8601 instant with an explicit offset/Z, parsed to a Date. */
export const instant = z.iso
  .datetime({ offset: true, message: "Use an ISO date-time with a timezone, e.g. 2026-11-01T10:00:00+06:00" })
  .transform((value) => new Date(value));

const text = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be ${max} characters or fewer`);

const duration = z
  .number()
  .int()
  .min(MIN_DURATION_MINUTES)
  .max(MAX_DURATION_MINUTES)
  .refine((n) => n % SLOT_MINUTES === 0, `Duration must be a multiple of ${SLOT_MINUTES} minutes`);

export const createBookingSchema = z.strictObject({
  workerId: z.uuid(),
  categorySlug: z.string().regex(/^[a-z0-9-]{1,50}$/, "Invalid service"),
  description: text(10, 1000, "Description"),
  serviceArea: z.enum(DIVISIONS),
  serviceAddress: text(5, 300, "Address"),
  startAt: instant,
  durationMinutes: duration,
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const GROUPS = ["all", "open", "active", "history", "disputed"] as const;
export const listBookingsSchema = z.object({
  role: z.enum(["customer", "worker"]).default("customer"),
  group: z.enum(GROUPS).default("all"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListBookingsQuery = z.infer<typeof listBookingsSchema>;

const money = z.number().int("Use whole taka").min(0).max(MAX_QUOTE_COMPONENT_BDT);
export const quoteSchema = z
  .strictObject({
    laborBdt: money,
    materialsBdt: money.default(0),
    otherBdt: money.default(0),
    description: text(10, 1000, "Description"),
    terms: text(1, 1000, "Terms").nullable().optional(),
    estimatedDurationMinutes: z.number().int().min(15).max(2880).nullable().optional(),
    validForHours: z.number().int().min(1).max(QUOTE_MAX_VALID_HOURS).default(QUOTE_DEFAULT_VALID_HOURS),
  })
  .refine((q) => q.laborBdt + q.materialsBdt + q.otherBdt > 0, {
    path: ["laborBdt"],
    message: "The quote total must be greater than zero",
  });
export type QuoteInput = z.infer<typeof quoteSchema>;

/** `expectedTotalBdt` lets the client assert what it saw; a mismatch is a 409, never a silent change. */
/** Action bodies are optional: a missing body is treated as `{}`. */
const optionalBody = <T extends z.ZodType>(schema: T) => z.preprocess((v) => v ?? {}, schema);
export const acceptQuoteSchema = optionalBody(z.strictObject({ expectedTotalBdt: z.number().int().positive().optional() }));
export const emptyBodySchema = optionalBody(z.strictObject({}));
export const reasonSchema = optionalBody(z.strictObject({ reason: text(5, 500, "Reason").optional() }));
export const rescheduleSchema = z.strictObject({ newStartAt: instant, reason: text(5, 500, "Reason").optional() });

export const availabilitySchema = z
  .strictObject({
    rules: z
      .array(
        z.strictObject({
          weekday: z.number().int().min(0).max(6),
          startMinute: z.number().int().min(0).max(1410),
          endMinute: z.number().int().min(30).max(1440),
        }),
      )
      .max(MAX_AVAILABILITY_WINDOWS),
  })
  .superRefine((value, ctx) => {
    value.rules.forEach((rule, i) => {
      if (rule.startMinute % SLOT_MINUTES !== 0 || rule.endMinute % SLOT_MINUTES !== 0) {
        ctx.addIssue({ code: "custom", path: ["rules", i], message: `Times must be on ${SLOT_MINUTES}-minute marks` });
      }
      if (rule.endMinute <= rule.startMinute) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "endMinute"], message: "End must be after start" });
      }
    });
    // No overlapping windows on the same weekday.
    const byDay = new Map<number, { start: number; end: number; i: number }[]>();
    value.rules.forEach((r, i) => byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), { start: r.startMinute, end: r.endMinute, i }]));
    for (const windows of byDay.values()) {
      windows.sort((a, b) => a.start - b.start);
      windows.forEach((w, k) => {
        if (k > 0 && w.start < windows[k - 1].end) {
          ctx.addIssue({ code: "custom", path: ["rules", w.i], message: "Windows on the same day must not overlap" });
        }
      });
    }
  });

export const timeOffSchema = z
  .strictObject({ startAt: instant, endAt: instant, note: text(1, 200, "Note").nullable().optional() })
  .refine((v) => v.endAt > v.startAt, { path: ["endAt"], message: "End must be after start" });

export const availabilityQuerySchema = z.object({
  from: z.string().refine(isDateKey, "Use YYYY-MM-DD").optional(),
  days: z.coerce.number().int().min(1).max(14).default(7),
  duration: z.coerce.number().int().min(MIN_DURATION_MINUTES).max(MAX_DURATION_MINUTES).refine((n) => n % SLOT_MINUTES === 0).default(60),
});

export const disputeSchema = z.strictObject({
  category: z.enum(["SERVICE_QUALITY", "NO_SHOW", "PRICE_DISAGREEMENT", "CONDUCT", "OTHER"]),
  description: text(20, 2000, "Description"),
});
export const disputeMessageSchema = z.strictObject({ body: text(1, 2000, "Message") });

export const adminDisputeListSchema = z.object({
  status: z.enum(["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION", "RESOLVED", "REJECTED", "CLOSED"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const adminMessageSchema = z.strictObject({ body: text(1, 2000, "Message"), internal: z.boolean().default(false) });
export const adminRequestInfoSchema = z.strictObject({ message: text(5, 2000, "Message") });
export const adminResolveSchema = z.strictObject({
  outcome: z.enum(["MARK_COMPLETED", "CANCEL_BOOKING", "RESTORE_BOOKING"]),
  resolution: text(10, 2000, "Resolution"),
});
export const adminRejectDisputeSchema = z.strictObject({ resolution: text(10, 2000, "Reason") });
