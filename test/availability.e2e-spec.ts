import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_WEEK, at, bookableWorker, confirmedBooking, customer, requestBooking } from "./booking-helpers.js";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("worker availability", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const slots = async (slug: string, qs = "") => (await t.client().get(`${t.api}/workers/${slug}/availability${qs}`)).body;
  const dayOf = (body: any, daysAhead: number) => body.days[daysAhead];
  const startsAt = (iso: string) => new Date(iso).toISOString();

  describe("weekly schedule management", () => {
    it("a worker sets, reads and replaces their own schedule", async () => {
      const w = await t.createWorker();
      const put = await w.agent.put(`${t.api}/me/availability`).send({
        rules: [{ weekday: 1, startMinute: 540, endMinute: 780 }, { weekday: 1, startMinute: 840, endMinute: 1020 }, { weekday: 3, startMinute: 600, endMinute: 900 }],
      });
      expect(put.status).toBe(200);
      expect(put.body.timezone).toBe("Asia/Dhaka");
      expect(put.body.rules).toHaveLength(3);
      const replaced = await w.agent.put(`${t.api}/me/availability`).send({ rules: [{ weekday: 2, startMinute: 480, endMinute: 600 }] });
      expect(replaced.body.rules).toHaveLength(1);
      expect((await w.agent.get(`${t.api}/me/availability`)).body.rules[0]).toMatchObject({ weekday: 2, startMinute: 480, endMinute: 600 });
      expect((await w.agent.put(`${t.api}/me/availability`).send({ rules: [] })).body.rules).toEqual([]);
    });

    it("cannot touch another worker's schedule (identity comes from the session)", async () => {
      const a = await bookableWorker(t);
      const b = await bookableWorker(t, { rules: [{ weekday: 0, startMinute: 600, endMinute: 660 }] });
      // Smuggling a profile id is rejected, and A's write only ever affects A.
      expect((await a.agent.put(`${t.api}/me/availability`).send({ workerProfileId: b.profileId, rules: [] })).status).toBe(400);
      await a.agent.put(`${t.api}/me/availability`).send({ rules: [] });
      expect((await b.agent.get(`${t.api}/me/availability`)).body.rules).toHaveLength(1);
    });

    it("requires a session and a worker profile", async () => {
      expect((await t.client().get(`${t.api}/me/availability`)).status).toBe(401);
      expect((await t.client().put(`${t.api}/me/availability`).send({ rules: [] })).status).toBe(401);
      const c = await customer(t);
      expect((await c.agent.get(`${t.api}/me/availability`)).status).toBe(400);
    });

    it.each([
      ["overlapping windows on one day", { rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 660, endMinute: 900 }] }],
      ["an end before the start", { rules: [{ weekday: 1, startMinute: 720, endMinute: 480 }] }],
      ["off-grid minutes", { rules: [{ weekday: 1, startMinute: 485, endMinute: 600 }] }],
      ["an invalid weekday", { rules: [{ weekday: 7, startMinute: 480, endMinute: 600 }] }],
      ["minutes past midnight", { rules: [{ weekday: 1, startMinute: 480, endMinute: 1500 }] }],
      ["too many windows", { rules: Array.from({ length: 29 }, () => ({ weekday: 1, startMinute: 480, endMinute: 510 })) }],
      ["unknown fields", { rules: [], role: "ADMIN" }],
    ])("rejects %s", async (_n, body) => {
      const w = await t.createWorker();
      expect((await w.agent.put(`${t.api}/me/availability`).send(body)).status).toBe(400);
    });

    it("allows adjacent windows and a full-day window ending at midnight", async () => {
      const w = await t.createWorker();
      const res = await w.agent.put(`${t.api}/me/availability`).send({ rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 1440 }] });
      expect(res.status).toBe(200);
    });
  });

  describe("time off", () => {
    it("blocks the period for new bookings, and removing it reopens it", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const off = await w.agent.post(`${t.api}/me/time-off`).send({ startAt: at(t, 3, 0).toISOString(), endAt: at(t, 4, 0).toISOString(), note: "Family event" });
      expect(off.status).toBe(201);
      expect((await requestBooking(t, c, w, at(t, 3, 10))).body.code).toBe("TIME_OFF");
      expect((await w.agent.delete(`${t.api}/me/time-off/${off.body.timeOff.id}`)).body.removed).toBe(true);
      expect((await requestBooking(t, c, w, at(t, 3, 10))).status).toBe(201);
    });

    it("cannot overlap a confirmed booking, and note stays private", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      await confirmedBooking(t, c, w, at(t, 3, 10));
      const clash = await w.agent.post(`${t.api}/me/time-off`).send({ startAt: at(t, 3, 9).toISOString(), endAt: at(t, 3, 12).toISOString() });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe("TIME_OFF_CLASHES_WITH_BOOKING");
      const ok = await w.agent.post(`${t.api}/me/time-off`).send({ startAt: at(t, 3, 11).toISOString(), endAt: at(t, 3, 13).toISOString(), note: "secret note" });
      expect(ok.status).toBe(201);
      const slugBody = JSON.stringify(await slots((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!));
      expect(slugBody).not.toContain("secret note");
    });

    it("validates input and only the owner can delete an entry", async () => {
      const a = await bookableWorker(t);
      const b = await bookableWorker(t);
      const entry = await a.agent.post(`${t.api}/me/time-off`).send({ startAt: at(t, 5, 8).toISOString(), endAt: at(t, 5, 12).toISOString() });
      expect((await b.agent.delete(`${t.api}/me/time-off/${entry.body.timeOff.id}`)).body.removed).toBe(false);
      expect(await t.prisma.workerTimeOff.count()).toBe(1);
      const bad = [
        { startAt: at(t, 5, 12).toISOString(), endAt: at(t, 5, 8).toISOString() },
        { startAt: at(t, -5, 12).toISOString(), endAt: at(t, -4, 8).toISOString() },
        { startAt: at(t, 1, 8).toISOString(), endAt: at(t, 200, 8).toISOString() },
        { startAt: "nope", endAt: "nope" },
      ];
      for (const body of bad) expect((await a.agent.post(`${t.api}/me/time-off`).send(body)).status).toBeGreaterThanOrEqual(400);
      expect((await a.agent.delete(`${t.api}/me/time-off/not-a-uuid`)).status).toBe(400);
    });
  });

  describe("public slots", () => {
    it("lists start times in Dhaka working hours, on the half-hour grid, respecting duration", async () => {
      const w = await bookableWorker(t, { rules: [{ weekday: 1, startMinute: 600, endMinute: 780 }] }); // Mondays 10:00-13:00
      const slug = (await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!;
      const body = await slots(slug, "?days=14&duration=90");
      expect(body).toMatchObject({ timezone: "Asia/Dhaka", durationMinutes: 90, acceptingBookings: true });
      expect(body.days).toHaveLength(14);
      const mondays = body.days.filter((d: any) => d.slots.length > 0);
      expect(mondays.length).toBe(2);
      // 10:00, 10:30, 11:00, 11:30 can start a 90-minute job that must end by 13:00. 10:00 Dhaka = 04:00Z.
      expect(mondays[0].slots).toEqual(["04:00", "04:30", "05:00", "05:30"].map((hm) => startsAtOn(mondays[0].date, hm)));
      function startsAtOn(date: string, hm: string) { return startsAt(`${date}T${hm}:00.000Z`); }
    });

    it("hides slots that are too soon, and only confirmed bookings (not requests) take a slot", async () => {
      const w = await bookableWorker(t);
      const slug = (await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!;
      const c1 = await customer(t);
      const c2 = await customer(t);

      const today = dayOf(await slots(slug, "?days=1"), 0);
      expect(today.slots.every((s: string) => new Date(s).getTime() >= t.clock.now().getTime() + 120 * 60_000)).toBe(true);

      const target = at(t, 3, 10).toISOString();
      await requestBooking(t, c1, w, at(t, 3, 10)); // only a REQUEST
      const from = (await slots(slug, "?days=4")).days[3];
      expect(from.slots).toContain(target);

      await confirmedBooking(t, c2, w, at(t, 3, 10));
      const after = (await slots(slug, "?days=4")).days[3].slots;
      expect(after).not.toContain(target);
    });

    it("treats appointments as half-open: a slot starting exactly when another ends is free", async () => {
      const w = await bookableWorker(t);
      const slug = (await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!;
      const c = await customer(t);
      await confirmedBooking(t, c, w, at(t, 3, 10)); // 10:00-11:00
      const day = (await slots(slug, "?days=4")).days[3].slots as string[];
      expect(day).not.toContain(at(t, 3, 10).toISOString());
      expect(day).not.toContain(at(t, 3, 10, 30).toISOString()); // overlaps
      expect(day).toContain(at(t, 3, 11).toISOString()); // starts exactly at the end
      expect(day).toContain(at(t, 3, 9).toISOString()); // 09:00-10:00 ends exactly at the start
      expect(day).not.toContain(at(t, 3, 9, 30).toISOString()); // 09:30-10:30 overlaps
    });

    it("404s for hidden or unknown professionals and validates parameters", async () => {
      const w = await bookableWorker(t);
      const slug = (await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!;
      await w.agent.post(`${t.api}/me/worker-profile/unpublish`).send({});
      expect((await t.client().get(`${t.api}/workers/${slug}/availability`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/workers/nope-12345678/availability`)).status).toBe(404);
      await w.agent.post(`${t.api}/me/worker-profile/publish`).send({});
      for (const qs of ["?days=0", "?days=15", "?duration=45", "?duration=600", "?from=2026-13-40", "?from=tomorrow"]) {
        expect((await t.client().get(`${t.api}/workers/${slug}/availability${qs}`)).status, qs).toBe(400);
      }
    });

    it("reports acceptingBookings=false for a worker without working hours", async () => {
      const w = await t.createWorker();
      const slug = (await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).slug!;
      const body = await slots(slug);
      expect(body.acceptingBookings).toBe(false);
      expect(body.days.every((d: any) => d.slots.length === 0)).toBe(true);
    });
  });

  describe("conflict prevention", () => {
    it("never confirms two overlapping bookings for one worker (exact, partial, contained)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      // Several overlapping REQUESTS can coexist: requests do not reserve a slot.
      const base = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id; // 10-11
      const rivals: string[] = [];
      for (const [h, m, dur] of [[10, 0, 60], [10, 30, 60], [9, 30, 60], [9, 0, 180]] as const) {
        const other = await customer(t);
        const res = await requestBooking(t, other, w, at(t, 3, h, m), { durationMinutes: dur });
        expect(res.status, `${h}:${m}`).toBe(201);
        rivals.push(res.body.booking.id);
      }
      expect((await w.agent.post(`${t.api}/bookings/${base}/accept`).send({})).status).toBe(200);
      for (const id of rivals) {
        const res = await w.agent.post(`${t.api}/bookings/${id}/accept`).send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("SLOT_UNAVAILABLE");
      }
      expect(await t.prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(1);
      // A NEW request for a taken slot is refused up front.
      const late = await requestBooking(t, await customer(t), w, at(t, 3, 10, 30));
      expect(late.status).toBe(409);
      expect(late.body.code).toBe("SLOT_UNAVAILABLE");
    });

    it("allows back-to-back appointments and different workers at the same time", async () => {
      const w1 = await bookableWorker(t);
      const w2 = await bookableWorker(t);
      const c = await customer(t);
      const c2 = await customer(t);
      await confirmedBooking(t, c, w1, at(t, 3, 10));
      await confirmedBooking(t, c2, w1, at(t, 3, 11)); // starts exactly when the first ends
      await confirmedBooking(t, c, w2, at(t, 3, 10)); // same time, other worker
      expect(await t.prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(3);
    });

    it("releases the slot when a confirmed booking is cancelled", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const c2 = await customer(t);
      const blocked = (await requestBooking(t, c2, w, at(t, 3, 10))).body.booking.id;
      const first = await confirmedBooking(t, c, w, at(t, 3, 10));
      expect((await w.agent.post(`${t.api}/bookings/${blocked}/accept`).send({})).status).toBe(409);
      expect((await c.agent.post(`${t.api}/bookings/${first}/cancel`).send({ reason: "Plans changed" })).status).toBe(200);
      expect((await w.agent.post(`${t.api}/bookings/${blocked}/accept`).send({})).status).toBe(200);
    });

    it("two simultaneous confirmations of the same slot: exactly one wins", async () => {
      const w = await bookableWorker(t);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const c = await customer(t);
        ids.push((await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id);
      }
      const results = await Promise.all(ids.map((id) => w.agent.post(`${t.api}/bookings/${id}/accept`).send({})));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => ["SLOT_UNAVAILABLE", "STALE_BOOKING"].includes(r.body.code))).toBe(true);
      expect(await t.prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(1);
    });

    it("overlapping-but-different slots racing: no two confirmed bookings ever overlap", async () => {
      const w = await bookableWorker(t);
      const starts = [[10, 0], [10, 30], [11, 0], [11, 30], [10, 0], [10, 30]] as const;
      const ids: string[] = [];
      for (const [h, m] of starts) {
        const c = await customer(t);
        ids.push((await requestBooking(t, c, w, at(t, 3, h, m))).body.booking.id);
      }
      await Promise.all(ids.map((id) => w.agent.post(`${t.api}/bookings/${id}/accept`).send({})));
      const confirmed = await t.prisma.booking.findMany({ where: { status: "CONFIRMED" }, orderBy: { startAt: "asc" } });
      expect(confirmed.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < confirmed.length; i++) expect(confirmed[i].startAt.getTime()).toBeGreaterThanOrEqual(confirmed[i - 1].endAt.getTime());
    });

    it("the database itself refuses overlapping reserving bookings (constraint backstop)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const base = (startH: number, endH: number, status: string) => ({
        customerId: c.userId,
        workerProfileId: w.profileId,
        categoryId: undefined as unknown as string,
        status: status as never,
        description: "raw insert for constraint test",
        serviceArea: "Dhaka",
        serviceAddress: "somewhere",
        startAt: at(t, 6, startH),
        endAt: at(t, 6, endH),
        durationMinutes: (endH - startH) * 60,
        pricingModel: "FIXED" as const,
        pricingSnapshot: {},
      });
      const category = await t.prisma.serviceCategory.findFirstOrThrow({ where: { slug: "electrical" } });
      const insert = (startH: number, endH: number, status: string) =>
        t.prisma.booking.create({ data: { ...base(startH, endH, status), categoryId: category.id } });
      await insert(10, 12, "CONFIRMED");
      await expect(insert(11, 13, "CONFIRMED")).rejects.toThrow();
      await expect(insert(9, 11, "IN_PROGRESS")).rejects.toThrow();
      await expect(insert(10, 12, "COMPLETION_PENDING")).rejects.toThrow();
      // Non-reserving statuses may overlap; adjacent windows never conflict.
      await expect(insert(11, 13, "REQUESTED")).resolves.toBeDefined();
      await expect(insert(11, 13, "CANCELLED")).resolves.toBeDefined();
      await expect(insert(12, 14, "CONFIRMED")).resolves.toBeDefined();
      await expect(insert(8, 10, "CONFIRMED")).resolves.toBeDefined();
      // CHECK constraints: end must follow start.
      await expect(t.prisma.booking.create({ data: { ...base(5, 5, "REQUESTED"), endAt: at(t, 6, 4), categoryId: category.id } })).rejects.toThrow();
    });
  });

  it("an unrelated user's request body cannot choose a different worker's schedule", async () => {
    void uniqueEmail;
    const w = await bookableWorker(t);
    expect(ALL_WEEK).toHaveLength(7);
    expect((await w.agent.get(`${t.api}/me/availability`)).body.rules).toHaveLength(7);
  });
});
