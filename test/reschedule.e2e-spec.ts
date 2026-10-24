import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, confirmedBooking, customer, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("rescheduling", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const ask = (who: Person | Worker, id: string, newStart: Date, reason?: string) =>
    who.agent.post(`${t.api}/bookings/${id}/reschedule`).send({ newStartAt: newStart.toISOString(), ...(reason && { reason }) });
  const decide = (who: Person | Worker, id: string, rid: string, verb: "accept" | "reject" | "withdraw") =>
    who.agent.post(`${t.api}/bookings/${id}/reschedule/${rid}/${verb}`).send({});
  const pendingId = async (id: string) => (await t.prisma.rescheduleRequest.findFirstOrThrow({ where: { bookingId: id, status: "PENDING" } })).id;
  const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });

  it("customer requests, worker accepts: the appointment moves and the old slot is released", async () => {
    const w = await bookableWorker(t);
    const c = await customer(t);
    const oldStart = at(t, 3, 10);
    const id = await confirmedBooking(t, c, w, oldStart);

    const req = await ask(c, id, at(t, 4, 14), "Need a later time");
    expect(req.status).toBe(200);
    expect(req.body.rescheduleRequests[0]).toMatchObject({ status: "PENDING", requestedByRole: "CUSTOMER", actions: ["withdraw"] });
    // The ORIGINAL appointment is untouched and still reserved while pending.
    expect((await row(id)).startAt).toEqual(oldStart);
    expect((await requestBooking(t, await customer(t), w, oldStart)).body.code).toBe("SLOT_UNAVAILABLE");
    // The worker is offered the decision; the requester is not.
    const workerView = (await w.agent.get(`${t.api}/bookings/${id}`)).body;
    expect(workerView.rescheduleRequests[0].actions).toEqual(["accept", "reject"]);
    expect(workerView.actions).not.toContain("reschedule"); // one open request at a time

    const rid = await pendingId(id);
    const done = await decide(w, id, rid, "accept");
    expect(done.status).toBe(200);
    expect(done.body.booking.startAt).toBe(at(t, 4, 14).toISOString());
    expect(done.body.booking.durationMinutes).toBe(60);
    expect(done.body.booking.pricing.agreedAmountBdt).toBe(500); // price is unchanged
    expect(done.body.rescheduleRequests[0]).toMatchObject({ status: "ACCEPTED", previousStartAt: oldStart.toISOString() });
    // The old slot is free; the new one is taken.
    expect((await requestBooking(t, await customer(t), w, oldStart)).status).toBe(201);
    expect((await requestBooking(t, await customer(t), w, at(t, 4, 14))).body.code).toBe("SLOT_UNAVAILABLE");
    expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "reschedule.accepted" } })).toBe(1);
  });

  it("worker requests, customer decides", async () => {
    const w = await bookableWorker(t);
    const c = await customer(t);
    const id = await confirmedBooking(t, c, w, at(t, 3, 10));
    await ask(w, id, at(t, 3, 15), "Running late that day");
    const rid = await pendingId(id);
    expect((await c.agent.get(`${t.api}/bookings/${id}`)).body.rescheduleRequests[0].actions).toEqual(["accept", "reject"]);
    expect((await decide(c, id, rid, "accept")).body.booking.startAt).toBe(at(t, 3, 15).toISOString());
  });

  it("a rejected or withdrawn request preserves the original appointment", async () => {
    const w = await bookableWorker(t);
    const c = await customer(t);
    const start = at(t, 3, 10);
    const id = await confirmedBooking(t, c, w, start);
    await ask(c, id, at(t, 4, 12));
    expect((await decide(w, id, await pendingId(id), "reject")).body.rescheduleRequests[0].status).toBe("REJECTED");
    expect((await row(id)).startAt).toEqual(start);
    await ask(c, id, at(t, 4, 12));
    expect((await decide(c, id, await pendingId(id), "withdraw")).body.rescheduleRequests[0].status).toBe("WITHDRAWN");
    expect((await row(id)).startAt).toEqual(start);
    expect((await row(id)).status).toBe("CONFIRMED");
  });

  describe("who may do what", () => {
    it("the requester cannot approve their own request; the other side cannot withdraw it; strangers get 404", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const otherWorker = await bookableWorker(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      await ask(c, id, at(t, 4, 12));
      const rid = await pendingId(id);
      expect((await decide(c, id, rid, "accept")).body.code).toBe("OWN_REQUEST");
      expect((await decide(c, id, rid, "reject")).body.code).toBe("OWN_REQUEST");
      expect((await decide(w, id, rid, "withdraw")).body.code).toBe("NOT_YOUR_REQUEST");
      for (const who of [stranger, otherWorker]) {
        expect((await ask(who, id, at(t, 5, 10))).status).toBe(404);
        expect((await decide(who, id, rid, "accept")).status).toBe(404);
      }
      expect((await t.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe("PENDING");
    });

    it("a request id from a different booking is a 404", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const a = await confirmedBooking(t, c, w, at(t, 3, 10));
      const b = await confirmedBooking(t, c, w, at(t, 4, 10));
      await ask(c, b, at(t, 4, 12));
      const ridOfB = await pendingId(b);
      expect((await decide(w, a, ridOfB, "accept")).status).toBe(404);
      expect((await row(b)).startAt).toEqual(at(t, 4, 10));
    });
  });

  describe("validation and policy", () => {
    it("only confirmed bookings can be rescheduled", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const requested = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      expect((await ask(c, requested, at(t, 4, 10))).body.code).toBe("INVALID_TRANSITION");
      const cancelled = await confirmedBooking(t, c, w, at(t, 5, 10));
      await c.agent.post(`${t.api}/bookings/${cancelled}/cancel`).send({ reason: "No longer needed" });
      expect((await ask(c, cancelled, at(t, 6, 10))).status).toBe(409);
      expect(await t.prisma.rescheduleRequest.count()).toBe(0);
    });

    it.each([
      ["the same time", () => at(t, 3, 10), "SAME_TIME"],
      ["a time in the past", () => at(t, -1, 10), "TOO_SOON"],
      ["an off-grid time", () => at(t, 4, 10, 15), "MISALIGNED_TIME"],
      ["a time outside working hours", () => at(t, 4, 3), "OUTSIDE_AVAILABILITY"],
      ["beyond the horizon", () => at(t, 200, 10), "TOO_FAR_AHEAD"],
    ])("rejects %s", async (_n, when, code) => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      const res = await ask(c, id, when());
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    });

    it("respects time off and other confirmed bookings, with half-open boundaries", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      await confirmedBooking(t, await customer(t), w, at(t, 4, 12)); // 12-13 taken
      await w.agent.post(`${t.api}/me/time-off`).send({ startAt: at(t, 5, 8).toISOString(), endAt: at(t, 5, 12).toISOString() });
      expect((await ask(c, id, at(t, 4, 12))).body.code).toBe("SLOT_UNAVAILABLE");
      expect((await ask(c, id, at(t, 4, 12, 30))).body.code).toBe("SLOT_UNAVAILABLE");
      expect((await ask(c, id, at(t, 5, 10))).body.code).toBe("TIME_OFF");
      expect((await ask(c, id, at(t, 4, 11))).status).toBe(200); // 11-12 ends exactly when 12-13 starts
    });

    it("allows shifting by 30 minutes (overlapping its own old window) without self-conflict", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      await ask(c, id, at(t, 3, 10, 30));
      expect((await decide(w, id, await pendingId(id), "accept")).body.booking.startAt).toBe(at(t, 3, 10, 30).toISOString());
    });

    it("allows only one open request at a time", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      expect((await ask(c, id, at(t, 4, 10))).status).toBe(200);
      const second = await ask(w, id, at(t, 5, 10));
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("RESCHEDULE_PENDING");
      const parallel = await Promise.all(Array.from({ length: 4 }, (_, i) => ask(w, id, at(t, 6 + i, 10))));
      expect(parallel.every((r) => r.status === 409)).toBe(true);
      expect(await t.prisma.rescheduleRequest.count({ where: { bookingId: id, status: "PENDING" } })).toBe(1);
    });

    it("an expired request cannot be accepted and leaves the booking alone", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 8, 10);
      const id = await confirmedBooking(t, c, w, start);
      await ask(c, id, at(t, 9, 10));
      const rid = await pendingId(id);
      t.clock.advanceMinutes(49 * 60);
      const res = await decide(w, id, rid, "accept");
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("RESCHEDULE_NOT_PENDING");
      expect((await row(id)).startAt).toEqual(start);
      expect((await c.agent.get(`${t.api}/bookings/${id}`)).body.rescheduleRequests[0].status).toBe("EXPIRED");
    });

    it("starting the job withdraws a pending request", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 2, 10); // requests stay open until the appointment starts at the latest
      const id = await confirmedBooking(t, c, w, start);
      await ask(c, id, at(t, 4, 10));
      t.clock.set(new Date(start.getTime() - 10 * 60_000)); // inside the start window, request still open
      await w.agent.post(`${t.api}/bookings/${id}/start`).send({});
      expect((await t.prisma.rescheduleRequest.findFirstOrThrow({ where: { bookingId: id } })).status).toBe("WITHDRAWN");
    });
  });

  describe("concurrency", () => {
    it("if the new slot is taken after the request, accepting fails and nothing changes", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      await ask(c, id, at(t, 4, 14));
      const rid = await pendingId(id);
      await confirmedBooking(t, await customer(t), w, at(t, 4, 14)); // someone else takes the target slot
      const res = await decide(w, id, rid, "accept");
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SLOT_UNAVAILABLE");
      expect((await row(id)).startAt).toEqual(start);
      expect((await t.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe("PENDING");
    });

    it("two bookings rescheduled into the same slot at once: only one moves", async () => {
      const w = await bookableWorker(t);
      const c1 = await customer(t);
      const c2 = await customer(t);
      const a = await confirmedBooking(t, c1, w, at(t, 3, 10));
      const b = await confirmedBooking(t, c2, w, at(t, 3, 12));
      await ask(c1, a, at(t, 4, 14));
      await ask(c2, b, at(t, 4, 14));
      const results = await Promise.all([decide(w, a, await pendingId(a), "accept"), decide(w, b, await pendingId(b), "accept")]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => ["SLOT_UNAVAILABLE", "STALE_BOOKING"].includes(r.body.code))).toBe(true);
      expect(await t.prisma.booking.count({ where: { startAt: at(t, 4, 14), status: "CONFIRMED" } })).toBe(1);
    });

    it("a reschedule racing a new confirmation for the same slot never double-books", async () => {
      const w = await bookableWorker(t);
      const c1 = await customer(t);
      const c2 = await customer(t);
      const a = await confirmedBooking(t, c1, w, at(t, 3, 10));
      const rival = (await requestBooking(t, c2, w, at(t, 4, 14))).body.booking.id;
      await ask(c1, a, at(t, 4, 14));
      const results = await Promise.all([decide(w, a, await pendingId(a), "accept"), w.agent.post(`${t.api}/bookings/${rival}/accept`).send({})]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await t.prisma.booking.count({ where: { startAt: at(t, 4, 14), status: "CONFIRMED" } })).toBe(1);
    });

    it("accept and reject of one request racing yield a single decision", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      await ask(c, id, at(t, 4, 14));
      const rid = await pendingId(id);
      const results = await Promise.all([decide(w, id, rid, "accept"), decide(w, id, rid, "reject"), decide(w, id, rid, "accept")]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const final = await t.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: rid } });
      const moved = (await row(id)).startAt.getTime() === at(t, 4, 14).getTime();
      expect(moved).toBe(final.status === "ACCEPTED");
    });
  });
});
