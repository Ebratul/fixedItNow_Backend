import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, confirmedBooking, customer, payableBooking, payBooking, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { TEST_ENV } from "./fake-providers.js";
import { createTestApp, type TestApp } from "./helpers.js";
import { bkashCallback, cancelViaDispute, latestBkashId, paymentStatus, pastThrottle, startPayment } from "./payment-helpers.js";

/**
 * The customer-worker service lifecycle end to end:
 *   request -> accept -> private chat -> arrival -> work finished (payment due) -> verified bKash payment
 *   -> completed -> review.
 * The payment provider is the MOCK in test/fake-providers.ts: these tests prove OUR rules (what the server
 * trusts, who may act, what is stored), not that real bKash behaves like the mock (docs/PAYMENTS.md).
 */
describe("booking workflow: chat, arrival, payment gate, reviews", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(TEST_ENV); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const post = (who: Person | Worker, path: string, body: object = {}) => who.agent.post(`${t.api}${path}`).send(body);
  const get = (who: Person | Worker, path: string) => who.agent.get(`${t.api}${path}`);
  const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
  const eventTypes = async (id: string) => (await t.prisma.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);
  const notices = (userId: string, type?: string) => t.prisma.notification.findMany({ where: { userId, ...(type && { type }) }, orderBy: { createdAt: "asc" } });
  const say = (who: Person | Worker, id: string, body: string, key = `k-${Math.random().toString(36).slice(2, 12)}`) =>
    post(who, `/bookings/${id}/chat/messages`, { body, clientMessageId: key });

  /** A confirmed booking with the clock moved inside the arrival window. */
  async function confirmed() {
    const w = await bookableWorker(t);
    const c = await customer(t, "Asha Rahman");
    const start = at(t, 3, 10);
    const id = await confirmedBooking(t, c, w, start);
    t.clock.set(new Date(start.getTime() - 10 * 60_000));
    return { w, c, id, start };
  }

  // ====================================================================== A. booking requests and decisions
  describe("requests and decisions", () => {
    it("notifies the professional of a new request and the customer of the decision, after the commit", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const created = await requestBooking(t, c, w, at(t, 3, 10));
      const id = created.body.booking.id as string;
      const incoming = await notices(w.userId, "booking.requested");
      expect(incoming).toHaveLength(1);
      expect(incoming[0]).toMatchObject({ link: `/bookings/${id}`, readAt: null });
      expect(incoming[0]!.body).not.toContain(c.email); // no account details in the notice

      await post(w, `/bookings/${id}/accept`);
      const accepted = await notices(c.userId, "booking.accepted");
      expect(accepted).toHaveLength(1);
      expect(accepted[0]!.link).toBe(`/bookings/${id}?chat=1`);

      const other = (await requestBooking(t, c, w, at(t, 4, 10))).body.booking.id as string;
      await post(w, `/bookings/${other}/decline`, { reason: "Not available" });
      expect(await notices(c.userId, "booking.declined")).toHaveLength(1);
    });

    it("does not notify twice when a request is replayed with the same idempotency key", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const body = { workerId: w.profileId, categorySlug: "electrical", description: "Fan is noisy and slow", serviceArea: "Dhaka", serviceAddress: "House 12, Road 5", startAt: at(t, 3, 10).toISOString(), durationMinutes: 60 };
      for (let i = 0; i < 2; i++) await c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "replay-key-0001").send(body);
      expect(await t.prisma.booking.count()).toBe(1);
      expect(await notices(w.userId, "booking.requested")).toHaveLength(1);
    });

    it("a declined booking is not reserved and opens no conversation", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = (await requestBooking(t, c, w, start)).body.booking.id as string;
      await post(w, `/bookings/${id}/decline`);
      expect((await get(c, `/bookings/${id}`)).body.chat).toMatchObject({ state: "NOT_OPEN" });
      expect((await say(c, id, "hello?")).status).toBe(409);
      // the same slot is free for somebody else
      const other = await customer(t);
      const again = await requestBooking(t, other, w, start);
      expect((await post(w, `/bookings/${again.body.booking.id}/accept`)).status).toBe(200);
    });

    it("a notification that cannot be stored does not undo the booking action", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      const original = t.prisma.notification.create.bind(t.prisma.notification);
      (t.prisma.notification as { create: unknown }).create = () => Promise.reject(new Error("notification store is down"));
      try {
        const res = await post(w, `/bookings/${id}/accept`);
        expect(res.status).toBe(200);
        expect(res.body.booking.status).toBe("CONFIRMED");
      } finally {
        (t.prisma.notification as { create: unknown }).create = original;
      }
      expect((await row(id)).status).toBe("CONFIRMED");
      expect(await notices(c.userId, "booking.accepted")).toHaveLength(0); // lost, and logged, but the acceptance stands
    });
  });

  // ====================================================================== B. arrival
  describe("arrival", () => {
    it("only the assigned professional can report arriving", async () => {
      const { w, c, id } = await confirmed();
      const otherWorker = await bookableWorker(t);
      const stranger = await customer(t);
      expect((await t.client().post(`${t.api}/bookings/${id}/arrive`).send({})).status).toBe(401);
      const asCustomer = await post(c, `/bookings/${id}/arrive`);
      expect(asCustomer.status).toBe(403);
      expect((await post(otherWorker, `/bookings/${id}/arrive`)).status).toBe(404);
      expect((await post(stranger, `/bookings/${id}/arrive`)).status).toBe(404);
      expect((await row(id)).arrivedAt).toBeNull();
      expect((await post(w, `/bookings/${id}/arrive`)).status).toBe(200);
    });

    it("stamps arrivedAt once, keeps the booking CONFIRMED and reserved, audits it and tells the customer once", async () => {
      const { w, c, id, start } = await confirmed();
      const first = await post(w, `/bookings/${id}/arrive`);
      expect(first.status).toBe(200);
      expect(first.body.booking.status).toBe("CONFIRMED");
      expect(new Date(first.body.booking.arrivedAt).getTime()).toBe(t.clock.now().getTime());
      expect(first.body.actions).not.toContain("arrive");
      expect(first.body.actions).not.toContain("reschedule");
      const events = await t.prisma.bookingEvent.findMany({ where: { bookingId: id, type: "booking.arrived" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorRole: "WORKER", actorUserId: w.userId, fromStatus: "CONFIRMED", toStatus: "CONFIRMED" });
      expect(events[0]!.metadata).toEqual({ selfReported: true }); // honest: no location was verified
      const told = await notices(c.userId, "booking.arrived");
      expect(told).toHaveLength(1);
      expect(told[0]!.link).toBe(`/bookings/${id}`);

      const again = await post(w, `/bookings/${id}/arrive`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("ALREADY_ARRIVED");
      expect(await notices(c.userId, "booking.arrived")).toHaveLength(1);
      // the slot is still reserved
      const rival = await customer(t);
      expect((await requestBooking(t, rival, w, start)).status).toBe(422);
      // the customer sees it on the booking
      expect((await get(c, `/bookings/${id}`)).body.booking.arrivedAt).toBe(first.body.booking.arrivedAt);
    });

    it("parallel arrival reports produce exactly one arrival", async () => {
      const { w, id } = await confirmed();
      const results = await Promise.all(Array.from({ length: 5 }, () => post(w, `/bookings/${id}/arrive`)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "booking.arrived" } })).toBe(1);
    });

    it("is refused in every state except CONFIRMED, and outside the arrival window", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const requested = (await requestBooking(t, c, w, start)).body.booking.id as string;
      expect((await post(w, `/bookings/${requested}/arrive`)).body.code).toBe("INVALID_TRANSITION");
      await post(w, `/bookings/${requested}/decline`);
      expect((await post(w, `/bookings/${requested}/arrive`)).status).toBe(409);

      const id = await confirmedBooking(t, c, w, at(t, 4, 10));
      expect((await post(w, `/bookings/${id}/arrive`)).body.code).toBe("TOO_EARLY"); // days before
      t.clock.set(new Date(at(t, 4, 10).getTime() + 26 * 3_600_000)); // a day after the appointment ended
      expect((await post(w, `/bookings/${id}/arrive`)).body.code).toBe("START_WINDOW_PASSED");
      expect((await row(id)).arrivedAt).toBeNull();

      const second = await confirmedBooking(t, c, w, at(t, 2, 14));
      await post(c, `/bookings/${second}/cancel`, { reason: "Plans changed completely" });
      t.clock.set(new Date(at(t, 2, 14).getTime() - 5 * 60_000));
      expect((await post(w, `/bookings/${second}/arrive`)).status).toBe(409);
    });

    it("is refused once the job has started, finished or been completed", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      expect((await post(w, `/bookings/${id}/arrive`)).status).toBe(409);
      await post(w, `/bookings/${id}/complete`);
      expect((await post(w, `/bookings/${id}/arrive`)).status).toBe(409);
      await payBooking(t, c, id);
      expect((await post(w, `/bookings/${id}/arrive`)).status).toBe(409);
    });

    it("starting without reporting arrival is allowed and does not invent an arrival time", async () => {
      const { w, id } = await confirmed();
      expect((await post(w, `/bookings/${id}/start`)).body.booking.status).toBe("IN_PROGRESS");
      expect((await row(id)).arrivedAt).toBeNull();
    });

    it("accepts no location or status data (nothing is GPS-verified)", async () => {
      const { w, id } = await confirmed();
      for (const extra of [{ latitude: 23.8, longitude: 90.4 }, { location: "here" }, { status: "WORKER_ARRIVED" }, { arrivedAt: "2026-01-01T00:00:00Z" }]) {
        expect((await post(w, `/bookings/${id}/arrive`, extra)).status, JSON.stringify(extra)).toBe(400);
      }
      expect((await row(id)).arrivedAt).toBeNull();
    });

    it("a pending reschedule request is withdrawn by the arrival", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      const asked = await post(c, `/bookings/${id}/reschedule`, { newStartAt: at(t, 4, 10).toISOString() });
      expect(asked.status).toBe(200);
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      await post(w, `/bookings/${id}/arrive`);
      expect(await t.prisma.rescheduleRequest.count({ where: { bookingId: id, status: "PENDING" } })).toBe(0);
    });
  });

  // ====================================================================== C. completion and the payment gate
  describe("work completion and payment", () => {
    it("completion makes payment DUE; it does not pay or complete the booking", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      const done = await post(w, `/bookings/${id}/complete`);
      expect(done.status).toBe(200);
      expect(done.body.booking).toMatchObject({ status: "COMPLETION_PENDING" });
      expect(done.body.booking.completionRequestedAt).toBeTruthy();
      expect(done.body.booking.completedAt).toBeNull();
      expect(done.body.payment).toEqual({ state: "UNPAID" });
      const mine = await get(c, `/bookings/${id}`);
      expect(mine.body.payment).toMatchObject({ state: "UNPAID", canPay: true, amountBdt: 500 });
      expect(mine.body.review.canReview).toBe(false);
      expect(await t.prisma.payment.count()).toBe(0);
      const due = await notices(c.userId, "booking.payment_due");
      expect(due).toHaveLength(1);
      expect(due[0]!.body).toContain("৳500");
    });

    it("the customer can declare the work finished early (before the professional's window opens): payment becomes due, nothing is completed", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t, "Asha Rahman");
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start); // the clock is days before the appointment: the professional cannot arrive or start yet
      expect((await post(w, `/bookings/${id}/arrive`)).body.code).toBe("TOO_EARLY");
      expect((await get(c, `/bookings/${id}`)).body.actions).toContain("mark_finished");
      expect((await get(w, `/bookings/${id}`)).body.actions).not.toContain("mark_finished");
      const stranger = await customer(t);
      expect((await post(w, `/bookings/${id}/mark-finished`)).status).toBe(403); // the professional uses "complete"
      expect((await post(stranger, `/bookings/${id}/mark-finished`)).status).toBe(404);
      expect((await t.client().post(`${t.api}/bookings/${id}/mark-finished`).send({})).status).toBe(401);
      expect((await post(c, `/bookings/${id}/mark-finished`, { status: "COMPLETED" })).status).toBe(400);

      const done = await post(c, `/bookings/${id}/mark-finished`);
      expect(done.status).toBe(200);
      expect(done.body.booking.status).toBe("COMPLETION_PENDING");
      expect(done.body.booking.completedAt).toBeNull();
      expect(done.body.payment).toMatchObject({ state: "UNPAID", canPay: true, amountBdt: 500 });
      expect(done.body.actions).not.toContain("mark_finished");
      const ev = await t.prisma.bookingEvent.findMany({ where: { bookingId: id, type: "booking.completion_requested" } });
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorRole: "CUSTOMER", actorUserId: c.userId, fromStatus: "CONFIRMED", toStatus: "COMPLETION_PENDING" });
      expect(await notices(w.userId, "booking.finished_by_customer")).toHaveLength(1);
      // a second press (double click) is a safe 409; the worker cannot report it again either
      expect((await post(c, `/bookings/${id}/mark-finished`)).status).toBe(409);
      expect((await post(w, `/bookings/${id}/complete`)).status).toBe(409);
      // paying completes it, exactly like the worker-reported path; a review then becomes possible
      expect((await post(c, `/bookings/${id}/review`, { rating: 5 })).status).toBe(422);
      await payBooking(t, c, id);
      expect((await row(id)).status).toBe("COMPLETED");
      expect((await post(c, `/bookings/${id}/review`, { rating: 5 })).status).toBe(201);
    });

    it("the customer can also finish a job already in progress, but not a request, a cancelled or a disputed booking", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      expect((await post(c, `/bookings/${id}/mark-finished`)).body.booking.status).toBe("COMPLETION_PENDING");

      const w2 = await bookableWorker(t);
      const requested = (await requestBooking(t, c, w2, at(t, 3, 10))).body.booking.id as string;
      expect((await post(c, `/bookings/${requested}/mark-finished`)).status).toBe(409);
      const cancelled = await confirmedBooking(t, c, w2, at(t, 4, 10));
      await post(c, `/bookings/${cancelled}/cancel`, { reason: "Plans changed completely" });
      expect((await post(c, `/bookings/${cancelled}/mark-finished`)).status).toBe(409);
      expect(await t.prisma.payment.count()).toBe(0); // nothing was charged by pressing the button
    });

    it("customer marking finished withdraws a pending reschedule request", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      await post(w, `/bookings/${id}/reschedule`, { newStartAt: at(t, 4, 10).toISOString() });
      await post(c, `/bookings/${id}/mark-finished`);
      expect(await t.prisma.rescheduleRequest.count({ where: { bookingId: id, status: "PENDING" } })).toBe(0);
    });

    it("only the assigned professional can finish the job, and a duplicate submission is a safe 409", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      const stranger = await bookableWorker(t);
      expect((await post(c, `/bookings/${id}/complete`)).status).toBe(403);
      expect((await post(stranger, `/bookings/${id}/complete`)).status).toBe(404);
      expect((await t.client().post(`${t.api}/bookings/${id}/complete`).send({})).status).toBe(401);
      const burst = await Promise.all(Array.from({ length: 4 }, () => post(w, `/bookings/${id}/complete`)));
      expect(burst.filter((r) => r.status === 200)).toHaveLength(1);
      expect(burst.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "booking.completion_requested" } })).toBe(1);
      expect(await notices(c.userId, "booking.payment_due")).toHaveLength(1);
    });

    it("cannot be finished before the job started, and no client status or amount is accepted anywhere", async () => {
      const { w, c, id } = await confirmed();
      expect((await post(w, `/bookings/${id}/complete`)).status).toBe(409);
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      expect((await post(c, `/bookings/${id}/confirm-completion`)).status).toBe(404); // the shortcut no longer exists
      for (const extra of [{ status: "COMPLETED" }, { amountBdt: 1 }, { paid: true }]) {
        expect((await post(w, `/bookings/${id}/complete`, extra)).status).toBe(400);
        expect((await startPayment(t, c, id, "BKASH", null, extra)).status).toBe(400);
      }
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
    });

    it("charges the stored agreed amount, whatever the client says", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const res = await startPayment(t, c, id, "BKASH");
      expect(res.body.payment.amountBdt).toBe(500);
      expect(t.net.callsTo("/payment/create")[0]!.json).toMatchObject({ amount: "500.00" });
    });

    it("an invalid payment reference is a 404 and changes nothing", async () => {
      const { c } = await confirmed();
      expect((await paymentStatus(t, c, "FIN000000000000000000000000")).status).toBe(404);
      expect((await bkashCallback(t, "FIN000000000000000000000000", "TR1", "success")).status).toBeLessThan(500);
      expect(await t.prisma.payment.count()).toBe(0);
    });

    it("a verified payment completes the booking exactly once and tells both people", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      const ref = started.body.payment.reference as string;
      const providerId = latestBkashId(t);
      expect((await row(id)).status).toBe("COMPLETION_PENDING"); // initiating is not paying
      t.net.bkashApprove(providerId);
      await Promise.all(Array.from({ length: 5 }, () => bkashCallback(t, ref, providerId)));
      const done = await row(id);
      expect(done.status).toBe("COMPLETED");
      expect(done.completedAt).not.toBeNull();
      expect(await eventTypes(id)).toEqual(expect.arrayContaining(["payment.verified", "booking.completed"]));
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "booking.completed" } })).toBe(1);
      expect(await t.prisma.payment.count({ where: { status: "SUCCEEDED" } })).toBe(1);
      expect(await notices(c.userId, "payment.succeeded")).toHaveLength(1);
      expect(await notices(w.userId, "payment.succeeded")).toHaveLength(1);
      // the professional learns only that a verified payment exists
      expect((await get(w, `/bookings/${id}`)).body.payment).toEqual({ state: "PAID" });
    });

    it("a browser redirect that claims success (nobody paid) never completes the booking, and the customer can retry", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const first = await startPayment(t, c, id, "BKASH");
      const ref = first.body.payment.reference as string;
      await bkashCallback(t, ref, latestBkashId(t), "success"); // forged: the customer never approved it in bKash
      expect((await paymentStatus(t, c, ref)).body.payment.status).not.toBe("SUCCEEDED");
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      expect((await get(c, `/bookings/${id}`)).body.payment).toMatchObject({ state: "UNPAID", canPay: true });
      expect(await notices(c.userId, "payment.failed")).toHaveLength(1); // the customer is told to try again

      const retry = await startPayment(t, c, id, "BKASH");
      expect(retry.status).toBe(201);
      t.net.bkashApprove(latestBkashId(t));
      await bkashCallback(t, retry.body.payment.reference, latestBkashId(t));
      expect((await row(id)).status).toBe("COMPLETED");
    });

    it("a payment still pending at the provider keeps the booking awaiting payment", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      pastThrottle(t);
      expect((await paymentStatus(t, c, started.body.payment.reference)).body.payment.status).toBe("INITIATED");
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      const detail = await get(c, `/bookings/${id}`);
      expect(detail.body.payment).toMatchObject({ state: "IN_PROGRESS", canPay: false, activeReference: started.body.payment.reference });
    });

    it("a provider timeout leaves the booking unpaid, and a delayed success is found later", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      const ref = started.body.payment.reference as string;
      const providerId = latestBkashId(t);
      t.net.bkashApprove(providerId);
      t.net.fail("/query/payment", "timeout", 2); // execute works, confirmation attempts time out
      await bkashCallback(t, ref, providerId);
      expect((await t.prisma.payment.findUniqueOrThrow({ where: { reference: ref } })).status).toBe("PROCESSING");
      expect((await row(id)).status).toBe("COMPLETION_PENDING"); // ambiguous is not paid, and not failed
      pastThrottle(t);
      await paymentStatus(t, c, ref);
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      pastThrottle(t);
      expect((await paymentStatus(t, c, ref)).body.payment.status).toBe("SUCCEEDED"); // the provider answered at last
      expect((await row(id)).status).toBe("COMPLETED");
      expect(t.net.callsTo("/payment/execute")).toHaveLength(1);
    });

    it("a payment completed at the provider while the callback was lost is recovered by a status check", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      t.net.bkashCompleteSilently(latestBkashId(t));
      pastThrottle(t);
      expect((await paymentStatus(t, c, started.body.payment.reference)).body.payment.status).toBe("SUCCEEDED");
      expect((await row(id)).status).toBe("COMPLETED");
    });

    it("an amount that does not match is parked for review and the booking stays awaiting payment", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      t.net.bkashApprove(latestBkashId(t), { amount: "100.00" });
      await bkashCallback(t, started.body.payment.reference, latestBkashId(t));
      expect((await paymentStatus(t, c, started.body.payment.reference)).body.payment.status).toBe("REQUIRES_REVIEW");
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      expect(await notices(c.userId, "payment.requires_review")).toHaveLength(1);
      expect(await notices(w.userId, "payment.succeeded")).toHaveLength(0);
      expect((await post(c, `/bookings/${id}/review`, { rating: 5 })).status).toBe(422);
    });

    it("a payment that arrives after a dispute was opened is recorded but does not complete the booking", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const started = await startPayment(t, c, id, "BKASH");
      await post(c, `/bookings/${id}/disputes`, { category: "SERVICE_QUALITY", description: "The work was not finished properly." });
      t.net.bkashApprove(latestBkashId(t));
      await bkashCallback(t, started.body.payment.reference, latestBkashId(t));
      expect((await row(id)).status).toBe("DISPUTED");
      const p = await t.prisma.payment.findUniqueOrThrow({ where: { reference: started.body.payment.reference } });
      expect(p).toMatchObject({ status: "SUCCEEDED", reviewReason: "BOOKING_INELIGIBLE" });
    });

    it("the customer cannot pay for somebody else's booking, nor can the professional", async () => {
      const { w, c, id } = await confirmed();
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      const stranger = await customer(t);
      expect((await startPayment(t, stranger, id, "BKASH")).status).toBe(404);
      expect((await startPayment(t, w, id, "BKASH")).status).toBe(404);
      expect((await startPayment(t, c, id, "BKASH")).status).toBe(201);
    });
  });

  // ====================================================================== D. reviews
  describe("reviews", () => {
    const review = (who: Person, id: string, body: object) => post(who, `/bookings/${id}/review`, body);
    const card = async (w: Worker) => (await t.client().get(`${t.api}/workers/${w.slug}`)).body.worker as { rating: number | null; reviewCount: number };

    it("is blocked until the payment is verified, for every earlier stage", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const requested = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      const confirmedId = await confirmedBooking(t, c, w, at(t, 4, 10));
      const cancelled = await confirmedBooking(t, c, w, at(t, 5, 10));
      await post(c, `/bookings/${cancelled}/cancel`, { reason: "Plans changed completely" });
      const pending = await payableBooking(t, c, w, {}, 7, 10); // finished, payment due, nothing paid
      for (const id of [requested, confirmedId, cancelled, pending]) {
        const res = await review(c, id, { rating: 5, comment: "Great" });
        expect(res.status, id).toBe(422);
        expect(res.body.code).toBe("BOOKING_NOT_REVIEWABLE");
        expect((await get(c, `/bookings/${id}`)).body.review.canReview).toBe(false);
      }
      expect(await t.prisma.review.count()).toBe(0);
      expect(await card(w)).toMatchObject({ rating: null, reviewCount: 0 });
    });

    it("is blocked for a declined booking too, and for a COMPLETED booking whose payment was never verified", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const declined = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      await post(w, `/bookings/${declined}/decline`);
      expect((await review(c, declined, { rating: 5 })).status).toBe(422);

      // an administrator completed a disputed job without any payment (the only way to be COMPLETED unpaid)
      const id = await payableBooking(t, c, w, {}, 6, 10);
      await post(c, `/bookings/${id}/disputes`, { category: "PRICE_DISAGREEMENT", description: "We disagree about the price of this job." });
      const dispute = await t.prisma.dispute.findUniqueOrThrow({ where: { bookingId: id } });
      const admin = await t.newAdmin();
      await post(admin, `/admin/disputes/${dispute.id}/review`);
      await post(admin, `/admin/disputes/${dispute.id}/resolve`, { outcome: "MARK_COMPLETED", resolution: "The work was done; payment is still owed." });
      expect((await row(id)).status).toBe("COMPLETED");
      const res = await review(c, id, { rating: 5 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PAYMENT_NOT_VERIFIED");
      expect((await get(c, `/bookings/${id}`)).body.review.canReview).toBe(false);
      // ...and once the customer really pays it, the booking becomes reviewable
      expect((await get(c, `/bookings/${id}`)).body.payment.canPay).toBe(true);
      await payBooking(t, c, id);
      expect((await row(id)).status).toBe("COMPLETED");
      expect((await review(c, id, { rating: 4 })).status).toBe(201);
    });

    it("lets only the booking's customer review, once, and attaches it to the assigned professional", async () => {
      const w = await bookableWorker(t);
      const other = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const id = await payableBooking(t, c, w);
      await payBooking(t, c, id);
      expect((await get(c, `/bookings/${id}`)).body.review.canReview).toBe(true);
      expect((await review(stranger, id, { rating: 1, comment: "Not my booking" })).status).toBe(404);
      expect((await review(w, id, { rating: 5 })).status).toBe(404); // a professional cannot review their own job
      expect((await t.client().post(`${t.api}/bookings/${id}/review`).send({ rating: 5 })).status).toBe(401);
      for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: "5" }, {}, { rating: 5, comment: "x".repeat(1001) }, { rating: 5, workerId: other.profileId }, { rating: 5, customerId: stranger.userId }]) {
        expect((await review(c, id, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      }
      const ok = await review(c, id, { rating: 5, comment: "Quick, tidy, fair price." });
      expect(ok.status).toBe(201);
      expect(await review(c, id, { rating: 1 })).toMatchObject({ status: 409, body: { code: "REVIEW_EXISTS" } });
      const stored = await t.prisma.review.findUniqueOrThrow({ where: { bookingId: id } });
      expect(stored).toMatchObject({ customerId: c.userId, workerProfileId: w.profileId, rating: 5 });
      expect(await t.prisma.review.count()).toBe(1);
      expect(await card(other)).toMatchObject({ rating: null, reviewCount: 0 }); // nobody else received it
    });

    it("parallel submissions create exactly one review", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await payableBooking(t, c, w);
      await payBooking(t, c, id);
      const results = await Promise.all(Array.from({ length: 5 }, () => review(c, id, { rating: 4 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await t.prisma.review.count()).toBe(1);
    });

    it("the professional's average and count come from the eligible reviews only, and the worker is notified", async () => {
      const w = await bookableWorker(t);
      const ratings = [5, 4, 4];
      for (const rating of ratings) {
        const c = await customer(t);
        const id = await payableBooking(t, c, w);
        await payBooking(t, c, id);
        expect((await review(c, id, { rating })).status).toBe(201);
      }
      // a fourth booking: finished and unpaid, with no review possible
      const lazy = await customer(t);
      const unpaid = await payableBooking(t, lazy, w, {}, 10, 10);
      await review(lazy, unpaid, { rating: 1 });
      expect(await card(w)).toMatchObject({ rating: 4.3, reviewCount: 3 });
      const listed = (await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).body;
      expect(listed.summary).toMatchObject({ rating: 4.3, reviewCount: 3 });
      expect(listed.reviews).toHaveLength(3);
      expect(listed.reviews.every((r: { verifiedBooking: boolean }) => r.verifiedBooking)).toBe(true);
      expect(await notices(w.userId, "review.received")).toHaveLength(3);
    });

    it("a review stops counting if its payment is fully refunded, but is kept", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await payableBooking(t, c, w);
      await payBooking(t, c, id);
      await review(c, id, { rating: 5 });
      expect(await card(w)).toMatchObject({ rating: 5, reviewCount: 1 });
      await t.prisma.payment.updateMany({ where: { bookingId: id }, data: { status: "REFUNDED", refundedAmountBdt: 500 } });
      expect(await card(w)).toMatchObject({ rating: null, reviewCount: 0 });
      expect(await t.prisma.review.count()).toBe(1);
    });
  });

  // ====================================================================== E. private chat
  describe("booking chat", () => {
    it("does not exist before the professional accepts", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      for (const who of [c, w]) {
        const read = await get(who, `/bookings/${id}/chat`);
        expect(read.status).toBe(409);
        expect(read.body.code).toBe("CHAT_NOT_AVAILABLE");
        expect((await say(who, id, "hello")).body.code).toBe("CHAT_NOT_AVAILABLE");
        expect((await get(who, `/bookings/${id}`)).body.chat).toMatchObject({ state: "NOT_OPEN" });
      }
      expect(await t.prisma.chatMessage.count()).toBe(0);
    });

    it("a quote-priced request has no chat until the customer accepts the quote", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10), { categorySlug: "ac-repair" })).body.booking.id as string;
      const quoted = await post(w, `/bookings/${id}/quotes`, { laborBdt: 800, materialsBdt: 300, otherBdt: 50, description: "Gas refill and filter cleaning." });
      expect((await say(c, id, "hi")).status).toBe(409);
      expect((await say(w, id, "hi")).status).toBe(409);
      await post(c, `/bookings/${id}/quotes/${quoted.body.quotes[0].id}/accept`);
      expect((await say(c, id, "Thanks for the quote")).status).toBe(201);
      expect(await notices(w.userId, "quote.received")).toHaveLength(0);
      expect(await notices(c.userId, "quote.received")).toHaveLength(1);
      expect(await notices(w.userId, "booking.accepted")).toHaveLength(1);
    });

    it("opens on acceptance: both people send and read, in order, with the right identities", async () => {
      const { w, c, id } = await confirmed();
      expect((await get(c, `/bookings/${id}`)).body.chat).toEqual({ state: "OPEN", reason: null });
      expect((await get(c, `/bookings/${id}/chat`)).body).toMatchObject({ messages: [], hasMore: false, counterparty: { displayName: "Rahim Uddin", role: "WORKER" } });
      const one = await say(c, id, "Please bring a ladder.", "client-key-0001");
      expect(one.status).toBe(201);
      expect(one.body.message).toMatchObject({ senderRole: "CUSTOMER", mine: true, body: "Please bring a ladder.", clientMessageId: "client-key-0001" });
      expect((await say(w, id, "Will do.", "worker-key-0001")).status).toBe(201);
      expect((await say(c, id, "Thank you!", "client-key-0002")).status).toBe(201);

      const asCustomer = (await get(c, `/bookings/${id}/chat`)).body;
      const asWorker = (await get(w, `/bookings/${id}/chat`)).body;
      expect(asCustomer.messages.map((m: { body: string }) => m.body)).toEqual(["Please bring a ladder.", "Will do.", "Thank you!"]);
      expect(asWorker.messages.map((m: { body: string }) => m.body)).toEqual(["Please bring a ladder.", "Will do.", "Thank you!"]);
      expect(asCustomer.messages.map((m: { mine: boolean }) => m.mine)).toEqual([true, false, true]);
      expect(asWorker.messages.map((m: { mine: boolean }) => m.mine)).toEqual([false, true, false]);
      expect(asWorker.counterparty).toMatchObject({ displayName: "Asha Rahman", role: "CUSTOMER", slug: null });
      // a client key is only ever returned to its author
      expect(asWorker.messages[0].clientMessageId).toBeUndefined();
      expect(asCustomer.messages[0].clientMessageId).toBe("client-key-0001");
      // no emails, user ids or internal fields leak into the payload
      const text = JSON.stringify(asCustomer);
      expect(text).not.toContain(w.email);
      expect(text).not.toContain(w.userId);
      expect(text).not.toContain(c.userId);
    });

    it("is private: strangers, other professionals, administrators and anonymous callers cannot read or write", async () => {
      const { w, c, id } = await confirmed();
      await say(c, id, "My address is secret.");
      const otherWorker = await bookableWorker(t);
      const stranger = await customer(t);
      const admin = await t.newAdmin();
      for (const who of [otherWorker, stranger, admin]) {
        expect((await get(who, `/bookings/${id}/chat`)).status).toBe(404);
        expect((await say(who, id, "let me in")).status).toBe(404);
      }
      expect((await t.client().get(`${t.api}/bookings/${id}/chat`)).status).toBe(401);
      expect((await t.client().post(`${t.api}/bookings/${id}/chat/messages`).send({ body: "x", clientMessageId: "anon-key-0001" })).status).toBe(401);
      expect((await get(w, "/bookings/not-a-uuid/chat")).status).toBe(400);
      expect((await get(c, "/bookings/00000000-0000-7000-8000-000000000000/chat")).status).toBe(404);
      expect(await t.prisma.chatMessage.count()).toBe(1);
      // messages are not part of any public, search or admin booking view
      expect(JSON.stringify((await t.client().get(`${t.api}/workers/${w.slug}`)).body)).not.toContain("secret");
      expect(JSON.stringify((await get(admin, "/admin/bookings")).body)).not.toContain("secret");
      expect(JSON.stringify((await get(c, `/bookings/${id}/history`)).body)).not.toContain("secret");
    });

    it("ignores forged participant data: sender, role and booking come from the session and the URL only", async () => {
      const { w, c, id } = await confirmed();
      const forged = { body: "I am the professional", clientMessageId: "forged-key-0001" };
      for (const extra of [{ senderId: w.userId }, { senderRole: "WORKER" }, { bookingId: "00000000-0000-7000-8000-000000000000" }, { sender: "x" }, { createdAt: "2020-01-01T00:00:00Z" }, { id: "x" }]) {
        expect((await post(c, `/bookings/${id}/chat/messages`, { ...forged, ...extra })).status, JSON.stringify(extra)).toBe(400);
      }
      expect(await t.prisma.chatMessage.count()).toBe(0);
      const ok = await post(c, `/bookings/${id}/chat/messages`, forged);
      expect(ok.body.message.senderRole).toBe("CUSTOMER");
      const stored = await t.prisma.chatMessage.findFirstOrThrow();
      expect(stored).toMatchObject({ senderId: c.userId, senderRole: "CUSTOMER", bookingId: id });
      expect(w.userId).not.toBe(stored.senderId);
    });

    it("the database itself refuses a message from a non-participant, a forged role, or an unconfirmed booking", async () => {
      const { w, c, id } = await confirmed();
      const stranger = await customer(t);
      const base = { bookingId: id, body: "x", clientMessageId: "db-key-00000001" };
      await expect(t.prisma.chatMessage.create({ data: { ...base, senderId: stranger.userId, senderRole: "CUSTOMER" } })).rejects.toThrow();
      await expect(t.prisma.chatMessage.create({ data: { ...base, senderId: c.userId, senderRole: "WORKER" } })).rejects.toThrow();
      await expect(t.prisma.chatMessage.create({ data: { ...base, senderId: w.userId, senderRole: "ADMIN" } })).rejects.toThrow();
      const request = (await requestBooking(t, c, w, at(t, 9, 10))).body.booking.id as string;
      await expect(t.prisma.chatMessage.create({ data: { ...base, bookingId: request, senderId: c.userId, senderRole: "CUSTOMER" } })).rejects.toThrow(/no conversation/);
      expect(await t.prisma.chatMessage.count()).toBe(0);
    });

    it("stored messages cannot be edited or deleted by anyone, including through the database client", async () => {
      const { c, id } = await confirmed();
      const sent = await say(c, id, "I agree to the price of 500 taka.");
      const messageId = sent.body.message.id as string;
      await expect(t.prisma.chatMessage.update({ where: { id: messageId }, data: { body: "tampered" } })).rejects.toThrow(/append-only/);
      await expect(t.prisma.chatMessage.delete({ where: { id: messageId } })).rejects.toThrow(/append-only/);
      expect((await t.prisma.chatMessage.findUniqueOrThrow({ where: { id: messageId } })).body).toBe("I agree to the price of 500 taka.");
      // and there is no edit/delete route
      for (const [method, path] of [["put", `/bookings/${id}/chat/messages/${messageId}`], ["patch", `/bookings/${id}/chat/messages/${messageId}`], ["delete", `/bookings/${id}/chat/messages/${messageId}`]] as const) {
        expect((await (c.agent as never as Record<string, (u: string) => Promise<{ status: number }>>)[method](`${t.api}${path}`)).status, method).toBe(404);
      }
    });

    it("a retried message (same client key) is stored once; the same key with other text is refused", async () => {
      const { c, id } = await confirmed();
      const first = await say(c, id, "Is 10 am fine?", "retry-key-00001");
      expect(first.status).toBe(201);
      const replay = await say(c, id, "Is 10 am fine?", "retry-key-00001");
      expect(replay.status).toBe(200);
      expect(replay.body.message.id).toBe(first.body.message.id);
      const clash = await say(c, id, "Something else entirely", "retry-key-00001");
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await t.prisma.chatMessage.count()).toBe(1);
    });

    it("a burst of identical retries (double click, flaky network) creates one row and one notification", async () => {
      const { w, c, id } = await confirmed();
      const burst = await Promise.all(Array.from({ length: 6 }, () => say(c, id, "Same message", "burst-key-00001")));
      expect(burst.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(burst.map((r) => r.body.message.id)).size).toBe(1);
      expect(await t.prisma.chatMessage.count()).toBe(1);
      expect(await notices(w.userId, "chat.message")).toHaveLength(1);
    });

    it("validates message text on the server", async () => {
      const { c, id } = await confirmed();
      const bad: object[] = [
        { body: "", clientMessageId: "valid-key-00001" },
        { body: "   \n  ", clientMessageId: "valid-key-00001" },
        { body: "x".repeat(2001), clientMessageId: "valid-key-00001" },
        { body: "bad\u0000char", clientMessageId: "valid-key-00001" },
        { body: "spoof ‮evil", clientMessageId: "valid-key-00001" },
        { body: 42, clientMessageId: "valid-key-00001" },
        { body: "ok" },
        { body: "ok", clientMessageId: "short" },
        { body: "ok", clientMessageId: "has spaces in it!" },
      ];
      for (const body of bad) expect((await post(c, `/bookings/${id}/chat/messages`, body)).status, JSON.stringify(body).slice(0, 50)).toBe(400);
      expect((await say(c, id, "x".repeat(2000), "max-length-key-1")).status).toBe(201);
      expect(await t.prisma.chatMessage.count()).toBe(1);
    });

    it("stores text verbatim (it is only ever rendered as text) and trims it", async () => {
      const { c, id } = await confirmed();
      const res = await say(c, id, "  <script>alert(1)</script> & \"quotes\"  ");
      expect(res.body.message.body).toBe("<script>alert(1)</script> & \"quotes\"");
    });

    it("notifies the other person of new messages without flooding them", async () => {
      const { w, c, id } = await confirmed();
      await say(c, id, "one");
      await say(c, id, "two");
      await say(c, id, "three");
      const unread = await notices(w.userId, "chat.message");
      expect(unread).toHaveLength(1);
      expect(unread[0]).toMatchObject({ link: `/bookings/${id}?chat=1`, readAt: null });
      expect(unread[0]!.body).not.toContain("one"); // message text is never copied into a notification
      expect(await notices(c.userId, "chat.message")).toHaveLength(0); // never the sender
      await t.prisma.notification.updateMany({ where: { userId: w.userId, type: "chat.message" }, data: { readAt: new Date() } });
      await say(c, id, "four");
      expect(await notices(w.userId, "chat.message")).toHaveLength(2);
    });

    it("returns only the latest page and can page back with a cursor", async () => {
      const { c, id } = await confirmed();
      const rows = Array.from({ length: 105 }, (_, i) => ({ bookingId: id, senderId: c.userId, senderRole: "CUSTOMER" as const, body: `m${i}`, clientMessageId: `bulk-key-${String(i).padStart(6, "0")}` }));
      await t.prisma.chatMessage.createMany({ data: rows });
      const latest = (await get(c, `/bookings/${id}/chat`)).body;
      expect(latest.messages).toHaveLength(100);
      expect(latest.hasMore).toBe(true);
      expect(latest.messages[0].body).toBe("m5");
      expect(latest.messages.at(-1).body).toBe("m104");
      const older = (await get(c, `/bookings/${id}/chat?before=${latest.messages[0].seq}`)).body;
      expect(older.messages.map((m: { body: string }) => m.body)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
      expect(older.hasMore).toBe(false);
      expect((await get(c, `/bookings/${id}/chat?before=abc`)).status).toBe(400);
    });

    it("stays open through the job and the payment, then read-only after the window; a cancelled booking is read-only", async () => {
      const { w, c, id } = await confirmed();
      await say(c, id, "before");
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      expect((await say(w, id, "work is finished")).status).toBe(201); // payment due: still open
      await payBooking(t, c, id);
      expect((await say(c, id, "paid, thanks")).status).toBe(201);
      expect((await get(c, `/bookings/${id}`)).body.chat.state).toBe("OPEN");

      t.clock.advanceMinutes(15 * 24 * 60); // past the 14-day window after completion
      const closed = await get(c, `/bookings/${id}`);
      expect(closed.body.chat).toMatchObject({ state: "READ_ONLY" });
      const sent = await say(c, id, "too late");
      expect(sent.status).toBe(409);
      expect(sent.body.code).toBe("CHAT_READ_ONLY");
      const history = (await get(w, `/bookings/${id}/chat`)).body;
      expect(history.chat.state).toBe("READ_ONLY");
      expect(history.messages.map((m: { body: string }) => m.body)).toEqual(["before", "work is finished", "paid, thanks"]);

      // cancelled after acceptance: history stays readable, nothing new can be sent
      const second = await confirmedBooking(t, c, w, at(t, 3, 10));
      await say(c, second, "see you");
      await post(c, `/bookings/${second}/cancel`, { reason: "Plans changed completely" });
      expect((await say(w, second, "ok")).body.code).toBe("CHAT_READ_ONLY");
      expect((await get(w, `/bookings/${second}/chat`)).body.messages).toHaveLength(1);
    });

    it("is read-only while a dispute is open, and the messages stay exactly as they were", async () => {
      const { w, c, id } = await confirmed();
      await say(w, id, "I will fix it tomorrow");
      await post(w, `/bookings/${id}/start`);
      await post(w, `/bookings/${id}/complete`);
      await post(c, `/bookings/${id}/disputes`, { category: "SERVICE_QUALITY", description: "The work is not what we agreed." });
      expect((await get(c, `/bookings/${id}`)).body.chat).toMatchObject({ state: "READ_ONLY" });
      expect((await say(c, id, "you lied")).body.code).toBe("CHAT_READ_ONLY");
      expect((await say(w, id, "i did not")).body.code).toBe("CHAT_READ_ONLY");
      expect((await get(c, `/bookings/${id}/chat`)).body.messages.map((m: { body: string }) => m.body)).toEqual(["I will fix it tomorrow"]);
      // withdrawing the dispute restores the booking, and with it the conversation
      await post(c, `/bookings/${id}/dispute/withdraw`);
      expect((await say(c, id, "sorted out")).status).toBe(201);
    });

    it("the per-conversation message limit holds", async () => {
      const { c, id } = await confirmed();
      const rows = Array.from({ length: 1000 }, (_, i) => ({ bookingId: id, senderId: c.userId, senderRole: "CUSTOMER" as const, body: "m", clientMessageId: `limit-key-${String(i).padStart(6, "0")}` }));
      await t.prisma.chatMessage.createMany({ data: rows });
      const res = await say(c, id, "one too many");
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CHAT_LIMIT_REACHED");
    });

    it("a cancelled-before-confirmation or expired booking never had a conversation", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      await post(c, `/bookings/${id}/cancel`);
      expect((await get(c, `/bookings/${id}/chat`)).status).toBe(409);
      expect((await get(c, `/bookings/${id}`)).body.chat).toEqual({ state: "NOT_OPEN", reason: null });
    });
  });

  // ====================================================================== F. the whole story
  describe("end to end", () => {
    it("request -> accept -> chat -> arrive -> finish -> failed then pending then verified payment -> review -> profile", async () => {
      const worker = await bookableWorker(t, { displayName: "Nasir Ahmed" });
      const cust = await customer(t, "Asha Rahman");
      const stranger = await customer(t, "Karim Mia");
      const start = at(t, 3, 10);

      // 1-3. request, accept
      const created = await requestBooking(t, cust, worker, start);
      expect(created.status).toBe(201);
      const id = created.body.booking.id as string;
      expect((await get(cust, "/bookings?role=customer&group=open")).body.bookings.map((b: { id: string }) => b.id)).toEqual([id]);
      expect((await get(worker, "/bookings?role=worker&group=open")).body.bookings.map((b: { id: string }) => b.id)).toEqual([id]);
      expect((await post(cust, `/bookings/${id}/accept`)).status).toBe(403);
      expect((await post(worker, `/bookings/${id}/accept`)).body.booking.status).toBe("CONFIRMED");

      // 4-6. chat is open for both, closed to others, and persists
      expect((await say(cust, id, "Please call before you arrive.", "e2e-key-000001")).status).toBe(201);
      expect((await say(worker, id, "Will do.", "e2e-key-000002")).status).toBe(201);
      expect((await get(stranger, `/bookings/${id}/chat`)).status).toBe(404);
      expect((await say(stranger, id, "hi")).status).toBe(404);
      expect(await t.prisma.chatMessage.count({ where: { bookingId: id } })).toBe(2);
      expect((await get(worker, `/bookings/${id}/chat`)).body.messages).toHaveLength(2);

      // 7-9. arrival, then finished => awaiting payment, NOT paid
      t.clock.set(new Date(start.getTime() - 5 * 60_000));
      expect((await post(worker, `/bookings/${id}/arrive`)).body.booking.arrivedAt).toBeTruthy();
      await post(worker, `/bookings/${id}/start`);
      const finished = await post(worker, `/bookings/${id}/complete`);
      expect(finished.body.booking.status).toBe("COMPLETION_PENDING");
      expect((await get(cust, `/bookings/${id}`)).body.payment).toMatchObject({ state: "UNPAID", canPay: true, amountBdt: 500 });

      // 10-11. a failed payment, then a pending one, and the customer can retry safely
      const failed = await startPayment(t, cust, id, "BKASH");
      await bkashCallback(t, failed.body.payment.reference, latestBkashId(t), "failure");
      expect((await paymentStatus(t, cust, failed.body.payment.reference)).body.payment.status).toBe("FAILED");
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      const pending = await startPayment(t, cust, id, "BKASH");
      expect(pending.status).toBe(201);
      expect((await get(cust, `/bookings/${id}`)).body.payment.state).toBe("IN_PROGRESS");
      expect((await startPayment(t, cust, id, "BKASH")).body.code).toBe("PAYMENT_IN_PROGRESS");
      expect((await row(id)).status).toBe("COMPLETION_PENDING");
      expect((await post(cust, `/bookings/${id}/review`, { rating: 5 })).status).toBe(422);

      // 12-13. the customer approves inside (mock) bKash; only the server-side verification completes the booking
      t.net.bkashApprove(latestBkashId(t));
      await bkashCallback(t, pending.body.payment.reference, latestBkashId(t));
      expect((await row(id)).status).toBe("COMPLETED");

      // 14-16. review: only the customer, once, on the right professional's profile
      expect((await post(stranger, `/bookings/${id}/review`, { rating: 1 })).status).toBe(404);
      const rated = await post(cust, `/bookings/${id}/review`, { rating: 5, comment: "Called ahead, tidy work." });
      expect(rated.status).toBe(201);
      expect((await post(cust, `/bookings/${id}/review`, { rating: 2 })).status).toBe(409);
      expect((await t.client().get(`${t.api}/workers/${worker.slug}`)).body.worker).toMatchObject({ rating: 5, reviewCount: 1 });
      const publicReviews = (await t.client().get(`${t.api}/workers/${worker.slug}/reviews`)).body.reviews;
      expect(publicReviews).toHaveLength(1);
      expect(publicReviews[0]).toMatchObject({ rating: 5, comment: "Called ahead, tidy work.", verifiedBooking: true });
      expect(JSON.stringify(publicReviews)).not.toContain(cust.email);

      // 17. audit trail, booking history and notifications are consistent
      expect(await eventTypes(id)).toEqual([
        "booking.requested", "booking.accepted", "booking.arrived", "booking.started", "booking.completion_requested", "payment.verified", "booking.completed",
      ]);
      const history = (await get(cust, `/bookings/${id}/history`)).body.events;
      expect(history.at(-1)).toMatchObject({ type: "booking.completed", actorRole: "SYSTEM", fromStatus: "COMPLETION_PENDING", toStatus: "COMPLETED" });
      const types = (userId: string) => notices(userId).then((n) => n.map((x) => x.type).sort());
      expect(await types(worker.userId)).toEqual(["booking.requested", "chat.message", "payment.succeeded", "review.received", "worker.verification"]); // the last one is the onboarding approval notice
      expect(await types(cust.userId)).toEqual(["booking.accepted", "booking.arrived", "booking.payment_due", "chat.message", "payment.failed", "payment.succeeded"]);
      expect(await t.prisma.payment.count({ where: { bookingId: id } })).toBe(2);
      expect(await t.prisma.payment.count({ where: { bookingId: id, status: "SUCCEEDED" } })).toBe(1);
    });

    it("a booking cancelled through a dispute after payment ends read-only and no longer counts its review", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await payableBooking(t, c, w);
      await payBooking(t, c, id);
      await post(c, `/bookings/${id}/review`, { rating: 5 });
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).body.worker.reviewCount).toBe(1);
      await cancelViaDispute(t, c, id);
      expect((await row(id)).status).toBe("CANCELLED");
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).body.worker.reviewCount).toBe(0);
      expect((await get(c, `/bookings/${id}`)).body.chat.state).toBe("READ_ONLY");
    });
  });
});
