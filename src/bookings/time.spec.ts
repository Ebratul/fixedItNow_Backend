import { describe, expect, it } from "vitest";
import { fitsRules } from "./availability.service.js";
import { addDays, isDateKey, isOnGrid, localInstant, localParts, overlaps, weekdayOf } from "./time.js";

describe("Asia/Dhaka time helpers", () => {
  it("round-trips local wall-clock time through an instant (guards the fixed +06:00 assumption)", () => {
    for (const [key, minute] of [["2026-01-15", 0], ["2026-06-30", 14 * 60 + 30], ["2026-12-31", 23 * 60 + 30], ["2027-03-28", 12 * 60]] as const) {
      const parts = localParts(localInstant(key, minute));
      expect(parts.dateKey).toBe(key);
      expect(parts.minuteOfDay).toBe(minute);
    }
  });

  it("is UTC+6 with no daylight-saving shift across the year", () => {
    expect(localInstant("2026-01-01", 600).toISOString()).toBe("2026-01-01T04:00:00.000Z");
    expect(localInstant("2026-07-01", 600).toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });

  it("handles the day boundary: 23:00 UTC is already tomorrow in Dhaka", () => {
    const p = localParts(new Date("2026-11-01T20:30:00Z"));
    expect(p).toMatchObject({ dateKey: "2026-11-02", minuteOfDay: 150 });
    expect(p.weekday).toBe(1); // Monday
  });

  it("computes weekdays and date arithmetic independent of time zones", () => {
    expect(weekdayOf("2026-11-01")).toBe(0); // Sunday
    expect(weekdayOf("2026-11-07")).toBe(6);
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("validates date keys", () => {
    expect(isDateKey("2026-02-28")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", "", "tomorrow"]) expect(isDateKey(bad)).toBe(false);
  });

  it("recognises the 30-minute grid in local time", () => {
    expect(isOnGrid(localInstant("2026-11-02", 10 * 60))).toBe(true);
    expect(isOnGrid(localInstant("2026-11-02", 10 * 60 + 30))).toBe(true);
    expect(isOnGrid(localInstant("2026-11-02", 10 * 60 + 15))).toBe(false);
    expect(isOnGrid(new Date(localInstant("2026-11-02", 600).getTime() + 1000))).toBe(false);
    expect(isOnGrid(new Date(localInstant("2026-11-02", 600).getTime() + 1))).toBe(false);
  });

  it("treats intervals as half-open: touching intervals do not overlap", () => {
    const d = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h, m));
    expect(overlaps(d(10), d(11), d(11), d(12))).toBe(false); // A ends exactly when B starts
    expect(overlaps(d(11), d(12), d(10), d(11))).toBe(false);
    expect(overlaps(d(10), d(11), d(10, 30), d(11, 30))).toBe(true);
    expect(overlaps(d(10), d(12), d(10, 30), d(11))).toBe(true); // containment
    expect(overlaps(d(10), d(11), d(10), d(11))).toBe(true);
  });
});

describe("fitsRules (weekly working hours)", () => {
  const monday = [{ weekday: 1, startMinute: 600, endMinute: 780 }]; // Mon 10:00-13:00
  const at = (key: string, hm: string) => { const [h, m] = hm.split(":").map(Number); return localInstant(key, h * 60 + m); };

  it("accepts appointments fully inside a window, including ending exactly at its end", () => {
    expect(fitsRules(monday, at("2026-11-02", "10:00"), at("2026-11-02", "11:00"))).toBe(true);
    expect(fitsRules(monday, at("2026-11-02", "12:00"), at("2026-11-02", "13:00"))).toBe(true);
  });
  it("rejects appointments that start early, end late, or fall on another weekday", () => {
    expect(fitsRules(monday, at("2026-11-02", "09:30"), at("2026-11-02", "10:30"))).toBe(false);
    expect(fitsRules(monday, at("2026-11-02", "12:30"), at("2026-11-02", "13:30"))).toBe(false);
    expect(fitsRules(monday, at("2026-11-03", "10:00"), at("2026-11-03", "11:00"))).toBe(false);
  });
  it("does not let an appointment span two separate windows", () => {
    const split = [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 840, endMinute: 1020 }];
    expect(fitsRules(split, at("2026-11-02", "11:00"), at("2026-11-02", "15:00"))).toBe(false);
  });
  it("supports a window ending at midnight, but never spans days", () => {
    const late = [{ weekday: 1, startMinute: 1200, endMinute: 1440 }];
    expect(fitsRules(late, at("2026-11-02", "22:30"), localInstant("2026-11-03", 0))).toBe(true);
    expect(fitsRules(late, at("2026-11-02", "23:30"), localInstant("2026-11-03", 30))).toBe(false);
  });
  it("uses Dhaka local weekday, not UTC's (Monday 02:00 Dhaka is still Sunday in UTC)", () => {
    const earlyMonday = [{ weekday: 1, startMinute: 0, endMinute: 240 }];
    expect(fitsRules(earlyMonday, new Date("2026-11-01T20:00:00Z"), new Date("2026-11-01T21:00:00Z"))).toBe(true);
  });
});
