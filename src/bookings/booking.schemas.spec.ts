import { describe, expect, it } from "vitest";
import { availabilitySchema, createBookingSchema, quoteSchema, timeOffSchema } from "./booking.schemas.js";

const base = {
  workerId: "0192a000-0000-7000-8000-000000000001",
  categorySlug: "electrical",
  description: "The ceiling fan is making a loud noise.",
  serviceArea: "Dhaka",
  serviceAddress: "House 12, Road 5",
  startAt: "2026-11-05T10:00:00+06:00",
  durationMinutes: 60,
};

describe("createBookingSchema", () => {
  it("parses the instant with its offset", () => {
    const r = createBookingSchema.parse(base);
    expect(r.startAt.toISOString()).toBe("2026-11-05T04:00:00.000Z");
  });
  it("accepts Z and rejects timezone-less or non-ISO dates", () => {
    expect(createBookingSchema.safeParse({ ...base, startAt: "2026-11-05T04:00:00Z" }).success).toBe(true);
    for (const bad of ["2026-11-05T10:00:00", "05/11/2026", "now", 1730000000]) expect(createBookingSchema.safeParse({ ...base, startAt: bad }).success).toBe(false);
  });
  it("trims text and rejects unknown (protected) fields", () => {
    expect(createBookingSchema.parse({ ...base, description: "   The ceiling fan is noisy.   " }).description).toBe("The ceiling fan is noisy.");
    for (const key of ["status", "customerId", "agreedAmountBdt", "idempotencyKey"]) expect(createBookingSchema.safeParse({ ...base, [key]: "x" }).success).toBe(false);
  });
  it("only allows 30-minute multiples up to 8 hours", () => {
    for (const d of [30, 60, 90, 480]) expect(createBookingSchema.safeParse({ ...base, durationMinutes: d }).success).toBe(true);
    for (const d of [0, 15, 45, 500, -30, 60.5]) expect(createBookingSchema.safeParse({ ...base, durationMinutes: d }).success).toBe(false);
  });
});

describe("quoteSchema", () => {
  const q = { laborBdt: 800, description: "Gas refill and filter cleaning." };
  it("defaults extras and validity, and never takes a total", () => {
    expect(quoteSchema.parse(q)).toMatchObject({ materialsBdt: 0, otherBdt: 0, validForHours: 48 });
    expect(quoteSchema.safeParse({ ...q, totalBdt: 5 }).success).toBe(false);
  });
  it("requires whole, non-negative taka and a positive total", () => {
    for (const bad of [{ laborBdt: -1 }, { laborBdt: 1.5 }, { laborBdt: 0 }, { laborBdt: "800" as unknown as number }, { laborBdt: 2_000_000 }]) {
      expect(quoteSchema.safeParse({ ...q, ...bad }).success).toBe(false);
    }
    expect(quoteSchema.safeParse({ laborBdt: 0, materialsBdt: 500, description: "Parts only, no labour." }).success).toBe(true);
  });
});

describe("availabilitySchema", () => {
  it("rejects overlaps, off-grid times and inverted ranges; accepts touching windows", () => {
    expect(availabilitySchema.safeParse({ rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 900 }] }).success).toBe(true);
    expect(availabilitySchema.safeParse({ rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 690, endMinute: 900 }] }).success).toBe(false);
    expect(availabilitySchema.safeParse({ rules: [{ weekday: 1, startMinute: 485, endMinute: 720 }] }).success).toBe(false);
    expect(availabilitySchema.safeParse({ rules: [{ weekday: 1, startMinute: 720, endMinute: 720 }] }).success).toBe(false);
    expect(availabilitySchema.safeParse({ rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 2, startMinute: 480, endMinute: 720 }] }).success).toBe(true);
  });
});

describe("timeOffSchema", () => {
  it("requires the end to follow the start", () => {
    expect(timeOffSchema.safeParse({ startAt: "2026-11-05T04:00:00Z", endAt: "2026-11-05T05:00:00Z" }).success).toBe(true);
    expect(timeOffSchema.safeParse({ startAt: "2026-11-05T05:00:00Z", endAt: "2026-11-05T04:00:00Z" }).success).toBe(false);
  });
});
