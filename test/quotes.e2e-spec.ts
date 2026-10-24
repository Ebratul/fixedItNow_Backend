import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, customer, quoteBody, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("quotes", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  /** ac-repair is QUOTE-priced in the default test profile. */
  const quoteRequest = async (c: Person, w: Worker, start = at(t, 3, 10)) => {
    const res = await requestBooking(t, c, w, start, { categorySlug: "ac-repair" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.booking.id as string;
  };
  const sendQuote = (w: Worker, id: string, extra: object = {}) => w.agent.post(`${t.api}/bookings/${id}/quotes`).send(quoteBody(extra));
  const quoted = async (c: Person, w: Worker, start = at(t, 3, 10)) => {
    const id = await quoteRequest(c, w, start);
    const res = await sendQuote(w, id);
    expect(res.status).toBe(200);
    return { id, quoteId: res.body.quotes[0].id as string };
  };
  const accept = (c: Person, id: string, quoteId: string, body: object = {}) => c.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/accept`).send(body);

  describe("creating a quote", () => {
    it("moves the booking to QUOTED with a server-computed total", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      const res = await sendQuote(w, id);
      expect(res.status).toBe(200);
      expect(res.body.booking.status).toBe("QUOTED");
      expect(res.body.quotes[0]).toMatchObject({ status: "PENDING", laborBdt: 800, materialsBdt: 300, otherBdt: 50, totalBdt: 1150, currency: "BDT" });
      expect(res.body.events.map((e: any) => e.type)).toEqual(["booking.requested", "quote.sent"]);
      // The customer sees it and can act on it.
      const view = (await c.agent.get(`${t.api}/bookings/${id}`)).body;
      expect(view.quotes[0].actions).toEqual(["accept", "reject"]);
      expect(view.actions).toContain("cancel");
    });

    it.each([
      ["a client-supplied total", { totalBdt: 1 }],
      ["a status", { status: "ACCEPTED" }],
      ["a negative amount", { laborBdt: -5 }],
      ["a fractional amount", { laborBdt: 99.5 }],
      ["a zero total", { laborBdt: 0, materialsBdt: 0, otherBdt: 0 }],
      ["an enormous amount", { laborBdt: 5_000_000 }],
      ["a string amount", { laborBdt: "800" }],
      ["a short description", { description: "x" }],
      ["an invalid validity period", { validForHours: 1000 }],
      ["an invalid currency field", { currency: "USD" }],
    ])("rejects %s", async (_n, extra) => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      expect((await sendQuote(w, id, extra)).status).toBe(400);
      expect(await t.prisma.quote.count()).toBe(0);
    });

    it("only the assigned worker may quote (customers get 403, other workers 404)", async () => {
      const w = await bookableWorker(t);
      const other = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      expect((await c.agent.post(`${t.api}/bookings/${id}/quotes`).send(quoteBody())).status).toBe(403);
      expect((await sendQuote(other, id)).status).toBe(404);
      expect(await t.prisma.quote.count()).toBe(0);
    });

    it("is not allowed for fixed-price services, and a worker cannot 'accept' a quote-priced request", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const fixed = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id; // electrical = FIXED
      expect((await sendQuote(w, fixed)).body.code).toBe("QUOTE_NOT_ALLOWED");
      const id = await quoteRequest(c, w, at(t, 4, 10));
      const res = await w.agent.post(`${t.api}/bookings/${id}/accept`).send({});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("QUOTE_REQUIRED");
    });

    it("a revision supersedes the pending quote and keeps the history", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      await sendQuote(w, id);
      const revised = await sendQuote(w, id, { laborBdt: 700 });
      expect(revised.body.booking.status).toBe("QUOTED");
      const statuses = revised.body.quotes.map((q: any) => [q.totalBdt, q.status]);
      expect(statuses).toEqual([[1050, "PENDING"], [1150, "WITHDRAWN"]]);
      expect(revised.body.events.map((e: any) => e.type)).toContain("quote.revised");
      expect(await t.prisma.quote.count({ where: { status: "PENDING" } })).toBe(1);
    });

    it("caps validity at the appointment start", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 2, 10);
      const id = await quoteRequest(c, w, start);
      const res = await sendQuote(w, id, { validForHours: 168 });
      expect(new Date(res.body.quotes[0].expiresAt).getTime()).toBe(start.getTime());
    });

    it("cannot quote a booking that is closed", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      await c.agent.post(`${t.api}/bookings/${id}/cancel`).send({});
      const res = await sendQuote(w, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_TRANSITION");
    });

    it("parallel quote submissions never leave two pending quotes", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w);
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sendQuote(w, id, { laborBdt: 500 + i })));
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(await t.prisma.quote.count({ where: { bookingId: id, status: "PENDING" } })).toBe(1);
    });
  });

  describe("accepting a quote", () => {
    it("confirms the booking at the STORED price and reserves the slot", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      // A price in the request is not even accepted by the schema.
      expect((await accept(c, id, quoteId, { totalBdt: 1 })).status).toBe(400);
      const res = await accept(c, id, quoteId, { expectedTotalBdt: 1150 });
      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ status: "CONFIRMED", pricing: { agreedAmountBdt: 1150 } });
      expect(res.body.quotes[0].status).toBe("ACCEPTED");
      const row = await t.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row.acceptedQuoteId).toBe(quoteId);
      expect(row.confirmedAt).toEqual(t.clock.now());
      expect(res.body.events.map((e: any) => e.type)).toEqual(["booking.requested", "quote.sent", "quote.accepted"]);
      // The slot is now taken for everyone else.
      expect((await requestBooking(t, await customer(t), w, at(t, 3, 10), { categorySlug: "ac-repair" })).body.code).toBe("SLOT_UNAVAILABLE");
    });

    it("fails with 409 when the client's expected total is stale, changing nothing", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      const res = await accept(c, id, quoteId, { expectedTotalBdt: 999 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("QUOTE_CHANGED");
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("QUOTED");
    });

    it("only the booking's customer can accept or reject", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      expect((await accept(stranger, id, quoteId)).status).toBe(404);
      expect((await accept(w as unknown as Person, id, quoteId)).status).toBe(403); // the worker cannot accept their own quote
      expect((await stranger.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/reject`).send({})).status).toBe(404);
      expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe("PENDING");
    });

    it("a quote from another booking cannot be used", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const a = await quoted(c, w, at(t, 3, 10));
      const b = await quoted(c, w, at(t, 4, 10));
      const res = await accept(c, a.id, b.quoteId);
      expect(res.status).toBe(404);
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("QUOTED");
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("QUOTED");
      // ...and another customer's booking id with my quote id is also a 404.
      const other = await customer(t);
      expect((await accept(other, a.id, a.quoteId)).status).toBe(404);
    });

    it("rejected, withdrawn, accepted and superseded quotes cannot be accepted", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);

      const r = await quoted(c, w, at(t, 3, 10));
      await c.agent.post(`${t.api}/bookings/${r.id}/quotes/${r.quoteId}/reject`).send({ reason: "Too expensive" });
      expect((await accept(c, r.id, r.quoteId)).body.code).toBe("QUOTE_NOT_PENDING");

      const wd = await quoted(c, w, at(t, 4, 10));
      await w.agent.post(`${t.api}/bookings/${wd.id}/quotes/${wd.quoteId}/withdraw`).send({});
      expect((await accept(c, wd.id, wd.quoteId)).body.code).toBe("QUOTE_NOT_PENDING");

      const sup = await quoted(c, w, at(t, 5, 10));
      await sendQuote(w, sup.id, { laborBdt: 100 });
      expect((await accept(c, sup.id, sup.quoteId)).body.code).toBe("QUOTE_NOT_PENDING");

      const ok = await quoted(c, w, at(t, 6, 10));
      expect((await accept(c, ok.id, ok.quoteId)).status).toBe(200);
      const again = await accept(c, ok.id, ok.quoteId);
      expect(again.status).toBe(409);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: ok.id, type: "quote.accepted" } })).toBe(1);
    });

    it("an expired quote cannot be accepted, and the booking returns to REQUESTED", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await quoteRequest(c, w, at(t, 10, 10));
      const q = (await sendQuote(w, id, { validForHours: 2 })).body.quotes[0].id;
      t.clock.advanceMinutes(121);
      const res = await accept(c, id, q);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("QUOTE_EXPIRED");
      const view = (await c.agent.get(`${t.api}/bookings/${id}`)).body; // lazy expiry is persisted on read
      expect(view.booking.status).toBe("REQUESTED");
      expect(view.quotes[0].status).toBe("EXPIRED");
      expect(view.quotes[0].actions).toEqual([]);
      // The worker can send a fresh quote.
      expect((await sendQuote(w, id)).body.booking.status).toBe("QUOTED");
    });

    it("fails with SLOT_UNAVAILABLE if someone else was confirmed meanwhile, and the quote stays pending", async () => {
      const w = await bookableWorker(t);
      const c1 = await customer(t);
      const c2 = await customer(t);
      const first = await quoted(c1, w, at(t, 3, 10));
      const rival = await requestBooking(t, c2, w, at(t, 3, 10)); // fixed-price request, same slot
      await w.agent.post(`${t.api}/bookings/${rival.body.booking.id}/accept`).send({});
      const res = await accept(c1, first.id, first.quoteId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SLOT_UNAVAILABLE");
      expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: first.quoteId } })).status).toBe("PENDING");
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("QUOTED");
    });

    it("fails if the worker is no longer publicly eligible", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "x" });
      const res = await accept(c, id, quoteId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("WORKER_UNAVAILABLE");
    });

    it("concurrent accepts of the SAME quote confirm exactly once", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      const results = await Promise.all(Array.from({ length: 6 }, () => accept(c, id, quoteId)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId: id, type: "quote.accepted" } })).toBe(1);
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id } })).agreedAmountBdt).toBe(1150);
    });

    it("concurrent accepts of two DIFFERENT customers' quotes for one slot confirm only one", async () => {
      const w = await bookableWorker(t);
      const people = await Promise.all(Array.from({ length: 4 }, () => customer(t)));
      const items = [];
      for (const c of people) items.push({ c, ...(await quoted(c, w, at(t, 3, 10))) });
      const results = await Promise.all(items.map(({ c, id, quoteId }) => accept(c, id, quoteId)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => ["SLOT_UNAVAILABLE", "STALE_BOOKING", "QUOTE_NOT_PENDING"].includes(r.body.code))).toBe(true);
      expect(await t.prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(1);
      expect(await t.prisma.quote.count({ where: { status: "ACCEPTED" } })).toBe(1);
    });
  });

  describe("rejecting and withdrawing", () => {
    it("reject keeps the booking open for a new quote", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      const res = await c.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/reject`).send({ reason: "Too expensive" });
      expect(res.body.booking.status).toBe("REQUESTED");
      expect(res.body.quotes[0].status).toBe("REJECTED");
      expect((await sendQuote(w, id, { laborBdt: 400 })).body.booking.status).toBe("QUOTED");
    });

    it("withdraw reverts to REQUESTED; only the quoting worker can do it", async () => {
      const w = await bookableWorker(t);
      const other = await bookableWorker(t);
      const c = await customer(t);
      const { id, quoteId } = await quoted(c, w);
      expect((await other.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/withdraw`).send({})).status).toBe(404);
      expect((await c.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/withdraw`).send({})).status).toBe(403);
      const res = await w.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/withdraw`).send({});
      expect(res.body.booking.status).toBe("REQUESTED");
      expect(res.body.quotes[0].status).toBe("WITHDRAWN");
    });
  });
});
