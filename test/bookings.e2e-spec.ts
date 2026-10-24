import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, bookingBody, confirmedBooking, customer, requestBooking, ALL_WEEK } from "./booking-helpers.js";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("booking requests", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  describe("creation", () => {
    it("lets an authenticated customer create a REQUESTED booking (not confirmed)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const res = await requestBooking(t, c, w, at(t, 3, 10));
      expect(res.status).toBe(201);
      expect(res.body.booking).toMatchObject({
        status: "REQUESTED",
        viewerRole: "CUSTOMER",
        durationMinutes: 60,
        timezone: "Asia/Dhaka",
        pricing: { model: "FIXED", unitPriceBdt: 500, agreedAmountBdt: null, currency: "BDT" },
      });
      expect(res.body.actions).toEqual(["cancel"]); // nothing to confirm yet, so no fake "success"
      expect(res.body.events.map((e: any) => e.type)).toEqual(["booking.requested"]);
    });

    it("requires authentication", async () => {
      const w = await bookableWorker(t);
      const res = await t.client().post(`${t.api}/bookings`).send(bookingBody(w, at(t, 3, 10)));
      expect(res.status).toBe(401);
      expect(await t.prisma.booking.count()).toBe(0);
    });

    it("always attributes the booking to the session user, ignoring a smuggled customer id", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const victim = await customer(t);
      const res = await requestBooking(t, c, w, at(t, 3, 10), { customerId: victim.userId });
      expect(res.status).toBe(400); // strict schema rejects unknown fields
      const ok = await requestBooking(t, c, w, at(t, 3, 10));
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: ok.body.booking.id } })).customerId).toBe(c.userId);
    });

    it.each([
      ["status", { status: "CONFIRMED" }],
      ["price", { agreedAmountBdt: 1, unitPriceBdt: 1, totalBdt: 1 }],
      ["worker verification", { verificationStatus: "VERIFIED" }],
      ["role", { role: "ADMIN" }],
    ])("rejects a client-supplied %s (mass assignment)", async (_n, extra) => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      expect((await requestBooking(t, c, w, at(t, 3, 10), extra)).status).toBe(400);
      expect(await t.prisma.booking.count()).toBe(0);
    });

    it("takes the price from the worker's stored pricing, not the browser", async () => {
      const w = await bookableWorker(t, { services: [{ categorySlug: "electrical", pricingModel: "HOURLY", basePriceBdt: 400 }] });
      const c = await customer(t);
      const res = await requestBooking(t, c, w, at(t, 3, 10), { durationMinutes: 90 });
      expect(res.body.booking.pricing).toMatchObject({ model: "HOURLY", unitPriceBdt: 400 });
      const acc = await w.agent.post(`${t.api}/bookings/${res.body.booking.id}/accept`).send({});
      expect(acc.body.booking.pricing.agreedAmountBdt).toBe(600); // 400/h x 1.5h
    });

    it("snapshots pricing so later profile edits do not rewrite history", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      await w.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "New Name", services: [{ categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 9000 }] });
      const detail = (await c.agent.get(`${t.api}/bookings/${id}`)).body.booking;
      expect(detail.pricing.unitPriceBdt).toBe(500);
      const row = await t.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect((row.pricingSnapshot as any).workerDisplayName).toBe("Rahim Uddin");
    });

    describe("worker eligibility", () => {
      it("rejects draft, pending, unpublished and suspended workers with the same answer", async () => {
        const admin = await t.newAdmin();
        const c = await customer(t);
        const draft = await t.createWorker({ stage: "draft" });
        const pending = await t.createWorker({ stage: "submitted" });
        const approved = await t.createWorker({ stage: "approved", admin });
        const hidden = await bookableWorker(t, { admin });
        await hidden.agent.post(`${t.api}/me/worker-profile/unpublish`).send({});
        const suspended = await bookableWorker(t, { admin });
        await admin.agent.post(`${t.api}/admin/workers/${suspended.profileId}/suspension`).send({ suspended: true, reason: "test" });
        const bodies = [];
        for (const w of [draft, pending, approved, hidden, suspended]) {
          const res = await requestBooking(t, c, w, at(t, 3, 10));
          expect(res.status).toBe(422);
          bodies.push(res.body);
        }
        expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
        expect(await t.prisma.booking.count()).toBe(0);
      });

      it("rejects unknown worker ids, services the worker doesn't offer, areas they don't serve, and self-booking", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        expect((await requestBooking(t, c, { profileId: "0192a000-0000-7000-8000-000000000000" }, at(t, 3, 10))).status).toBe(422);
        expect((await requestBooking(t, c, w, at(t, 3, 10), { categorySlug: "painting" })).body.code).toBe("SERVICE_NOT_OFFERED");
        expect((await requestBooking(t, c, w, at(t, 3, 10), { serviceArea: "Sylhet" })).body.code).toBe("AREA_NOT_SERVED");
        expect((await requestBooking(t, w, w, at(t, 3, 10))).body.code).toBe("OWN_PROFILE");
      });

      it("a worker with no working hours cannot be booked", async () => {
        const w = await t.createWorker(); // never set availability
        const c = await customer(t);
        const res = await requestBooking(t, c, w, at(t, 3, 10));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe("OUTSIDE_AVAILABILITY");
      });
    });

    describe("time validation", () => {
      it.each([
        ["in the past", () => at(t, -1, 10), "TOO_SOON"],
        ["inside the minimum lead time", () => new Date(t.clock.now().getTime() + 60 * 60_000), "TOO_SOON"],
        ["beyond the booking horizon", () => at(t, 120, 10), "TOO_FAR_AHEAD"],
        ["off the 30-minute grid", () => at(t, 3, 10, 15), "MISALIGNED_TIME"],
        ["before working hours", () => at(t, 3, 6), "OUTSIDE_AVAILABILITY"],
        ["ending after working hours", () => at(t, 3, 19, 30), "OUTSIDE_AVAILABILITY"],
      ])("rejects a start %s", async (_label, start, code) => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        const res = await requestBooking(t, c, w, start());
        expect(res.status).toBe(422);
        expect(res.body.code).toBe(code);
      });

      it.each([
        ["a malformed date", { startAt: "tomorrow" }],
        ["a date without a timezone", { startAt: "2026-11-05T10:00:00" }],
        ["a zero duration", { durationMinutes: 0 }],
        ["a non-grid duration", { durationMinutes: 45 }],
        ["an over-long duration", { durationMinutes: 600 }],
        ["a short description", { description: "fan" }],
        ["an over-long description", { description: "x".repeat(1001) }],
        ["an empty address", { serviceAddress: "  " }],
        ["an unknown area", { serviceArea: "Atlantis" }],
        ["a non-uuid worker id", { workerId: "123" }],
      ])("rejects %s", async (_label, extra) => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        expect((await requestBooking(t, c, w, at(t, 3, 10), extra)).status).toBe(400);
      });

      it("accepts a booking that ends exactly at closing time (half-open end)", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        expect((await requestBooking(t, c, w, at(t, 3, 19))).status).toBe(201);
      });
    });

    describe("duplicates and idempotency", () => {
      it("replays the same Idempotency-Key as the same booking, not a new one", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        const send = () => c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "form-abc12345").send(bookingBody(w, at(t, 3, 10)));
        const first = await send();
        const second = await send();
        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body.booking.id).toBe(first.body.booking.id);
        expect(await t.prisma.booking.count()).toBe(1);
      });

      it("rejects reusing a key for a different booking", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        await c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "form-abc12345").send(bookingBody(w, at(t, 3, 10)));
        const other = await c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "form-abc12345").send(bookingBody(w, at(t, 4, 10)));
        expect(other.status).toBe(409);
        expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      });

      it("rejects malformed keys", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        const res = await c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "x").send(bookingBody(w, at(t, 3, 10)));
        expect(res.status).toBe(400);
      });

      it("collapses simultaneous identical submissions without a key to one booking", async () => {
        const w = await bookableWorker(t);
        const c = await customer(t);
        const results = await Promise.all(Array.from({ length: 5 }, () => requestBooking(t, c, w, at(t, 3, 10))));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "DUPLICATE_REQUEST")).toBe(true);
        expect(await t.prisma.booking.count()).toBe(1);
      });

      it("rejects an overlapping second request to the same worker, but allows a different worker or time", async () => {
        const w1 = await bookableWorker(t);
        const w2 = await bookableWorker(t);
        const c = await customer(t);
        expect((await requestBooking(t, c, w1, at(t, 3, 10))).status).toBe(201);
        expect((await requestBooking(t, c, w1, at(t, 3, 10, 30))).body.code).toBe("DUPLICATE_REQUEST");
        expect((await requestBooking(t, c, w1, at(t, 3, 11))).status).toBe(201); // back-to-back is fine
        expect((await requestBooking(t, c, w2, at(t, 3, 10))).status).toBe(201);
      });
    });
  });

  describe("reading bookings (object-level authorization)", () => {
    it("only the customer and the assigned worker can read a booking; everyone else gets the same 404", async () => {
      const w = await bookableWorker(t);
      const other = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const admin = await t.newAdmin();
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;

      expect((await c.agent.get(`${t.api}/bookings/${id}`)).status).toBe(200);
      expect((await w.agent.get(`${t.api}/bookings/${id}`)).status).toBe(200);
      const denied = [
        await stranger.agent.get(`${t.api}/bookings/${id}`),
        await other.agent.get(`${t.api}/bookings/${id}`),
        await admin.agent.get(`${t.api}/bookings/${id}`),
        await t.client().get(`${t.api}/bookings/${id}`),
        await c.agent.get(`${t.api}/bookings/0192a000-0000-7000-8000-000000000000`),
      ];
      expect(denied.map((r) => r.status)).toEqual([404, 404, 404, 401, 404]);
      expect(denied[0].body).toEqual(denied[4].body); // indistinguishable from "does not exist"
      for (const path of ["history", "dispute"]) {
        expect((await stranger.agent.get(`${t.api}/bookings/${id}/${path}`)).status).toBe(404);
      }
      expect((await c.agent.get(`${t.api}/bookings/not-a-uuid`)).status).toBe(400);
    });

    it("hides the street address from the worker until the booking is confirmed", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      const before = (await w.agent.get(`${t.api}/bookings/${id}`)).body.booking;
      expect(before.serviceAddress).toBeNull();
      expect(before.serviceArea).toBe("Dhaka");
      await w.agent.post(`${t.api}/bookings/${id}/accept`).send({});
      expect((await w.agent.get(`${t.api}/bookings/${id}`)).body.booking.serviceAddress).toBe("House 12, Road 5, Dhanmondi");
    });

    it("never exposes emails, user ids, or internal fields", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await confirmedBooking(t, c, w, at(t, 3, 10));
      for (const who of [c, w]) {
        const text = JSON.stringify((await who.agent.get(`${t.api}/bookings/${id}`)).body);
        for (const secret of [c.email, w.email, c.userId, w.userId, "idempotencyKey", "pricingSnapshot", "cancelledByUserId", "customerId", "actorUserId"]) {
          expect(text, `leaked ${secret}`).not.toContain(secret);
        }
      }
    });

    it("lists only the caller's bookings, per role, with bounded pagination", async () => {
      const w = await bookableWorker(t);
      const c1 = await customer(t);
      const c2 = await customer(t);
      for (let i = 0; i < 3; i++) await requestBooking(t, c1, w, at(t, 3 + i, 10));
      await requestBooking(t, c2, w, at(t, 3, 14));

      const mine = (await c1.agent.get(`${t.api}/bookings?role=customer`)).body;
      expect(mine.total).toBe(3);
      expect((await c2.agent.get(`${t.api}/bookings?role=customer`)).body.total).toBe(1);
      expect((await w.agent.get(`${t.api}/bookings?role=worker`)).body.total).toBe(4);
      // Acting as "worker" without being the worker yields nothing, not someone else's data.
      expect((await c1.agent.get(`${t.api}/bookings?role=worker`)).body.total).toBe(0);
      expect((await w.agent.get(`${t.api}/bookings?role=customer`)).body.total).toBe(0);

      const page = (await c1.agent.get(`${t.api}/bookings?pageSize=2&page=2`)).body;
      expect(page).toMatchObject({ total: 3, totalPages: 2, page: 2 });
      expect(page.bookings).toHaveLength(1);
      expect((await c1.agent.get(`${t.api}/bookings?pageSize=500`)).status).toBe(400);
      expect((await c1.agent.get(`${t.api}/bookings?group=everything`)).status).toBe(400);
      expect((await t.client().get(`${t.api}/bookings`)).status).toBe(401);
    });

    it("groups bookings (open / active / history) and shows past unanswered requests as expired", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const open = (await requestBooking(t, c, w, at(t, 8, 10))).body.booking.id;
      const active = await confirmedBooking(t, c, w, at(t, 9, 10));
      const soon = (await requestBooking(t, c, w, at(t, 5, 10))).body.booking.id;
      const group = async (g: string) => (await c.agent.get(`${t.api}/bookings?group=${g}`)).body.bookings.map((b: any) => b.id);
      expect(await group("open")).toEqual(expect.arrayContaining([open, soon]));
      expect(await group("active")).toEqual([active]);
      expect(await group("history")).toEqual([]);

      t.clock.set(at(t, 5, 12)); // the third request's start time has now passed unanswered
      expect(await group("open")).toEqual([open]);
      const history = (await c.agent.get(`${t.api}/bookings?group=history`)).body.bookings;
      expect(history.map((b: any) => [b.id, b.status])).toEqual([[soon, "EXPIRED"]]);
    });
  });

  it("does not let a worker view bookings through a customer-style request for another worker", async () => {
    const w1 = await bookableWorker(t);
    const w2 = await bookableWorker(t);
    const c = await customer(t);
    const id = (await requestBooking(t, c, w1, at(t, 3, 10))).body.booking.id;
    expect((await w2.agent.post(`${t.api}/bookings/${id}/accept`).send({})).status).toBe(404);
    expect((await w2.agent.post(`${t.api}/bookings/${id}/decline`).send({})).status).toBe(404);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("REQUESTED");
  });

  it("rejects cross-origin writes and over-large payloads", async () => {
    const w = await bookableWorker(t, { rules: ALL_WEEK });
    const c = await customer(t);
    const evil = await c.agent.post(`${t.api}/bookings`).set("Origin", "https://evil.example").send(bookingBody(w, at(t, 3, 10)));
    expect(evil.status).toBe(403);
    const big = await c.agent.post(`${t.api}/bookings`).send({ ...bookingBody(w, at(t, 3, 10)), description: "x".repeat(300_000) });
    expect(big.status).toBe(413);
    void uniqueEmail;
  });

  it("throttles booking creation per client (abuse protection)", async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: "true" });
    try {
      const c = await limited.signUpAndLogin(uniqueEmail("limited"));
      const statuses: number[] = [];
      for (let i = 0; i < 13; i++) statuses.push((await c.agent.post(`${limited.api}/bookings`).send({})).status);
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true); // validation errors, still counted
      expect(statuses.slice(10)).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it("stores description text verbatim (no HTML is ever interpreted server-side)", async () => {
    const w = await bookableWorker(t);
    const c = await customer(t);
    const evil = "<img src=x onerror=alert(1)> please fix my fan";
    const res = await requestBooking(t, c, w, at(t, 3, 10), { description: evil });
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.booking.description).toBe(evil);
  });
});
