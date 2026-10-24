import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, confirmedBooking, customer, quoteBody, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("booking lifecycle", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const post = (who: Person | Worker, id: string, action: string, body: object = {}) => who.agent.post(`${t.api}/bookings/${id}/${action}`).send(body);
  const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
  const eventTypes = async (id: string) => (await t.prisma.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);

  describe("happy path", () => {
    it("request -> accept -> start -> complete -> confirm, each step explicit and audited", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      expect((await row(id)).status).toBe("CONFIRMED");

      // Cannot start long before the appointment.
      const early = await post(w, id, "start");
      expect(early.status).toBe(422);
      expect(early.body.code).toBe("TOO_EARLY");

      t.clock.set(new Date(start.getTime() - 20 * 60_000)); // inside the 30-minute early window
      expect((await post(w, id, "start")).body.booking.status).toBe("IN_PROGRESS");
      const done = await post(w, id, "complete");
      expect(done.body.booking.status).toBe("COMPLETION_PENDING");
      expect(done.body.actions).toEqual(["open_dispute"]); // only a dispute remains possible for the worker
      const confirm = await post(c, id, "confirm-completion");
      expect(confirm.body.booking.status).toBe("COMPLETED");
      expect(confirm.body.booking.completedAt).toBeTruthy();
      expect(await eventTypes(id)).toEqual([
        "booking.requested", "booking.accepted", "booking.started", "booking.completion_requested", "booking.completed",
      ]);
      // History is readable by both participants and carries the actors' roles.
      const hist = (await c.agent.get(`${t.api}/bookings/${id}/history`)).body.events;
      expect(hist.map((e: any) => e.actorRole)).toEqual(["CUSTOMER", "WORKER", "WORKER", "WORKER", "CUSTOMER"]);
    });

    it("offers each participant only the actions that will actually succeed", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = (await requestBooking(t, c, w, start)).body.booking.id;
      const actions = async (who: Person | Worker) => (await who.agent.get(`${t.api}/bookings/${id}`)).body.actions;
      expect(await actions(c)).toEqual(["cancel"]);
      expect((await actions(w)).sort()).toEqual(["accept", "decline"]);
      await post(w, id, "accept");
      expect((await actions(c)).sort()).toEqual(["cancel", "reschedule"]);
      expect((await actions(w)).sort()).toEqual(["cancel", "reschedule"]); // "start" appears only inside the window
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      expect((await actions(w)).sort()).toEqual(["cancel", "start"]); // too close to the start to reschedule
      await post(w, id, "start");
      expect((await actions(w)).sort()).toEqual(["complete", "open_dispute"]);
      expect(await actions(c)).toEqual(["open_dispute"]);
      await post(w, id, "complete");
      expect((await actions(c)).sort()).toEqual(["confirm_completion", "open_dispute"]);
    });
  });

  describe("role and ownership rules", () => {
    it("customers cannot run worker actions and workers cannot run customer actions", async () => {
      const w = await bookableWorker(t);
      const other = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = (await requestBooking(t, c, w, start)).body.booking.id;
      expect((await post(c, id, "accept")).status).toBe(403);
      expect((await post(c, id, "decline")).status).toBe(403);
      expect((await post(other, id, "accept")).status).toBe(404);
      await post(w, id, "accept");
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      expect((await post(c, id, "start")).status).toBe(403);
      await post(w, id, "start");
      expect((await post(c, id, "complete")).status).toBe(403);
      await post(w, id, "complete");
      expect((await post(w, id, "confirm-completion")).status).toBe(403); // the worker cannot confirm their own work
      expect((await post(other, id, "confirm-completion")).status).toBe(404);
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
    });

    it("no endpoint accepts a client-supplied status", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      for (const who of [c, w]) {
        expect((await post(who, id, "complete", { status: "COMPLETED" })).status).toBe(400);
        expect((await who.agent.patch(`${t.api}/bookings/${id}`).send({ status: "COMPLETED" })).status).toBe(404);
        expect((await who.agent.put(`${t.api}/bookings/${id}`).send({ status: "COMPLETED" })).status).toBe(404);
      }
      expect((await row(id)).status).toBe("CONFIRMED");
    });
  });

  describe("invalid transitions are rejected with a consistent 409", () => {
    it.each([
      ["complete before start", "CONFIRMED", "worker", "complete"],
      ["confirm completion before the worker reports it", "CONFIRMED", "customer", "confirm-completion"],
      ["accept an already confirmed booking", "CONFIRMED", "worker", "accept"],
      ["decline a confirmed booking (use cancel)", "CONFIRMED", "worker", "decline"],
    ])("%s", async (_n, _s, who, action) => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      const res = await post(who === "worker" ? w : c, id, action);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_TRANSITION");
      expect((await row(id)).status).toBe("CONFIRMED");
    });

    it("a cancelled booking cannot be started, accepted, completed, quoted, rescheduled or cancelled again", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      expect((await post(c, id, "cancel", { reason: "Changed my mind" })).body.booking.status).toBe("CANCELLED");
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      for (const [who, action, body] of [
        [w, "start", {}], [w, "accept", {}], [w, "complete", {}], [c, "confirm-completion", {}],
        [c, "cancel", { reason: "again again" }], [w, "cancel", { reason: "also cancelling" }], [c, "reschedule", { newStartAt: at(t, 4, 10).toISOString() }],
      ] as const) {
        const res = await post(who, id, action, body);
        expect(res.status, `${action}`).toBe(409);
      }
      expect(await eventTypes(id)).toEqual(["booking.requested", "booking.accepted", "booking.cancelled"]); // no double cancellation event
    });

    it("a completed booking cannot be cancelled through the normal flow, nor restarted", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      t.clock.set(start);
      await post(w, id, "start");
      await post(w, id, "complete");
      await post(c, id, "confirm-completion");
      for (const [who, action, body] of [[c, "cancel", { reason: "too late now" }], [w, "cancel", { reason: "too late now" }], [w, "start", {}], [c, "confirm-completion", {}]] as const) {
        expect((await post(who, id, action, body)).status).toBe(409);
      }
      expect((await row(id)).status).toBe("COMPLETED");
    });

    it("an in-progress job cannot be cancelled (open a dispute instead)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      t.clock.set(start);
      await post(w, id, "start");
      expect((await post(c, id, "cancel", { reason: "I changed my mind" })).status).toBe(409);
      expect((await post(w, id, "cancel", { reason: "I changed my mind" })).status).toBe(409);
    });

    it("the start window closes 24 hours after the appointment ends", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      t.clock.set(new Date(start.getTime() + 26 * 3_600_000));
      const res = await post(w, id, "start");
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("START_WINDOW_PASSED");
    });
  });

  describe("declining", () => {
    it("the worker can decline a request or a quoted request; it is terminal", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const a = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      const res = await post(w, a, "decline", { reason: "Fully booked that week" });
      expect(res.body.booking.status).toBe("DECLINED");
      expect((await post(w, a, "accept")).status).toBe(409);

      const q = (await requestBooking(t, c, w, at(t, 4, 10), { categorySlug: "ac-repair" })).body.booking.id;
      await post(w, q, "quotes", quoteBody());
      const d = await post(w, q, "decline");
      expect(d.body.booking.status).toBe("DECLINED");
      expect(d.body.quotes[0].status).toBe("WITHDRAWN"); // open proposals die with the request
    });

    it("a suspended worker cannot accept new work, but can still decline or cancel", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      const c = await customer(t);
      const pending = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      const confirmed = await confirmedBooking(t, c, w, at(t, 4, 10));
      const pending2 = (await requestBooking(t, c, w, at(t, 5, 10))).body.booking.id;
      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "x" });
      const res = await post(w, pending, "accept");
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      expect((await post(w, pending, "decline")).status).toBe(200);
      expect((await post(w, confirmed, "cancel", { reason: "Suspended account" })).status).toBe(200);
      // Customers can always cancel their own requests.
      expect((await post(c, pending2, "cancel")).status).toBe(200);
    });
  });

  describe("cancellation policy", () => {
    it("the customer may cancel a request without a reason, and it is recorded", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      const res = await post(c, id, "cancel");
      expect(res.body.booking.status).toBe("CANCELLED");
      expect(res.body.booking.cancellation).toMatchObject({ by: "CUSTOMER", reason: null });
      const r = await row(id);
      expect(r.cancelledByUserId).toBe(c.userId);
      expect(r.cancelledAt).toEqual(t.clock.now());
    });

    it("cancelling a CONFIRMED booking needs a reason, records the actor, and releases the slot", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      const noReason = await post(c, id, "cancel");
      expect(noReason.status).toBe(422);
      expect(noReason.body.code).toBe("REASON_REQUIRED");
      expect((await post(c, id, "cancel", { reason: "abc" })).status).toBe(400); // too short
      const res = await post(w, id, "cancel", { reason: "Equipment failure, sorry" });
      expect(res.body.booking.cancellation).toMatchObject({ by: "WORKER", reason: "Equipment failure, sorry" });
      // The slot is free again.
      expect((await requestBooking(t, await customer(t), w, at(t, 3, 10))).status).toBe(201);
    });

    it("a worker cancels unconfirmed requests with 'decline', not 'cancel'", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      const res = await post(w, id, "cancel", { reason: "No thanks really" });
      expect(res.status).toBe(409);
      expect((await row(id)).status).toBe("REQUESTED");
    });

    it("marks late cancellations and flags paid-booking review without creating any payment or refund", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const early = await confirmedBooking(t, c, w, at(t, 5, 10));
      const late = await confirmedBooking(t, c, w, at(t, 2, 14));
      t.clock.set(at(t, 2, 4)); // ten hours before the second appointment
      await post(c, early, "cancel", { reason: "Plans changed a lot" });
      await post(c, late, "cancel", { reason: "Plans changed a lot" });
      const meta = async (id: string) => (await t.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: id, type: "booking.cancelled" } })).metadata as any;
      expect(await meta(early)).toMatchObject({ wasConfirmed: true, lateCancellation: false, paymentReviewRequired: true });
      expect(await meta(late)).toMatchObject({ wasConfirmed: true, lateCancellation: true, paymentReviewRequired: true });
      // Cancelling only records a marker for review: it creates no payment and no refund, and moves no money.
      expect(await t.prisma.payment.count()).toBe(0);
      expect(await t.prisma.refund.count()).toBe(0);
    });

    it("cancellation closes pending quotes and reschedule requests in the same transaction", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const q = (await requestBooking(t, c, w, at(t, 3, 10), { categorySlug: "ac-repair" })).body.booking.id;
      await post(w, q, "quotes", quoteBody());
      await post(c, q, "cancel");
      expect(await t.prisma.quote.count({ where: { bookingId: q, status: "PENDING" } })).toBe(0);
      expect((await t.prisma.quote.findFirstOrThrow({ where: { bookingId: q } })).status).toBe("WITHDRAWN");

      const id = await confirmedBooking(t, c, w, at(t, 4, 10));
      await post(c, id, "reschedule", { newStartAt: at(t, 4, 14).toISOString() });
      await post(w, id, "cancel", { reason: "Cannot make it at all" });
      expect(await t.prisma.rescheduleRequest.count({ where: { bookingId: id, status: "PENDING" } })).toBe(0);
    });

    it("concurrent cancellations produce exactly one cancellation event", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      const results = await Promise.all([
        post(c, id, "cancel", { reason: "Reason number one" }),
        post(c, id, "cancel", { reason: "Reason number one" }),
        post(w, id, "cancel", { reason: "Reason number two" }),
        post(w, id, "cancel", { reason: "Reason number two" }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "booking.cancelled" } })).toBe(1);
    });
  });

  describe("expiry (applied lazily; no scheduler yet)", () => {
    it("an unanswered request becomes EXPIRED once its start time passes and can no longer be accepted", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = (await requestBooking(t, c, w, start)).body.booking.id;
      t.clock.set(new Date(start.getTime() + 60_000));
      const res = await post(w, id, "accept");
      expect(res.status).toBe(409);
      const view = (await c.agent.get(`${t.api}/bookings/${id}`)).body;
      expect(view.booking.status).toBe("EXPIRED");
      expect(view.actions).toEqual([]);
      expect((await row(id)).status).toBe("EXPIRED"); // persisted by the read
      expect(await eventTypes(id)).toEqual(["booking.requested", "booking.expired"]);
      expect((await post(c, id, "cancel")).status).toBe(409);
    });
  });

  describe("history", () => {
    it("is append-only, ordered, and limited to participants", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      expect((await stranger.agent.get(`${t.api}/bookings/${id}/history`)).status).toBe(404);
      const events = (await w.agent.get(`${t.api}/bookings/${id}/history`)).body.events;
      expect(events.map((e: any) => [e.fromStatus, e.toStatus])).toEqual([[null, "REQUESTED"], ["REQUESTED", "CONFIRMED"]]);
      expect(JSON.stringify(events)).not.toMatch(/actorUserId|userId/);
    });
  });
});
