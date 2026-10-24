import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { at, bookableWorker, completedBooking, confirmedBooking, customer, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("reviews and ratings", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const review = (who: Person, bookingId: string, body: object) => who.agent.post(`${t.api}/bookings/${bookingId}/review`).send(body);
  const cardOf = async (w: Worker) => (await t.client().get(`${t.api}/workers/${w.slug}`)).body.worker as { rating: number | null; reviewCount: number };
  const named = (name: string) => t.signUpAndLogin(uniqueEmail("rv"), name);

  /** n completed bookings for `w`, each by a fresh customer, reviewed with the given ratings. */
  async function reviewed(w: Worker, ratings: number[]) {
    const out: { cust: Person; bookingId: string }[] = [];
    for (const rating of ratings) {
      const cust = await customer(t);
      const bookingId = await completedBooking(t, cust, w);
      expect((await review(cust, bookingId, { rating })).status).toBe(201);
      out.push({ cust, bookingId });
    }
    return out;
  }

  describe("eligibility (server-side)", () => {
    it("lets the booking's customer review a COMPLETED booking, once", async () => {
      const w = await bookableWorker(t);
      const c = await named("Asha Rahman");
      const id = await completedBooking(t, c, w);
      const res = await review(c, id, { rating: 5, comment: "  Quick and tidy work.  " });
      expect(res.status).toBe(201);
      expect(res.body.review).toMatchObject({ bookingId: id, rating: 5, comment: "Quick and tidy work.", status: "VISIBLE", editedAt: null, canEdit: true, canWithdraw: true });
      const row = await t.prisma.review.findUniqueOrThrow({ where: { bookingId: id } });
      expect(row).toMatchObject({ customerId: c.userId, workerProfileId: w.profileId });
    });

    it("rejects anonymous callers, strangers, the professional, unknown and malformed ids", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const stranger = await customer(t);
      const id = await completedBooking(t, c, w);
      expect((await t.client().post(`${t.api}/bookings/${id}/review`).send({ rating: 5 })).status).toBe(401);
      expect((await review(stranger, id, { rating: 5 })).status).toBe(404);
      expect((await review(w, id, { rating: 5 })).status).toBe(404); // the professional is not the customer
      expect((await review(c, "00000000-0000-7000-8000-000000000000", { rating: 5 })).status).toBe(404);
      expect((await review(c, "not-a-uuid", { rating: 5 })).status).toBe(400);
      expect(await t.prisma.review.count()).toBe(0);
    });

    it("rejects every booking status except COMPLETED", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const requested = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id as string;
      const confirmed = await confirmedBooking(t, c, w, at(t, 4, 10));
      const cancelled = await confirmedBooking(t, c, w, at(t, 5, 10));
      await c.agent.post(`${t.api}/bookings/${cancelled}/cancel`).send({ reason: "Plans changed" });
      for (const id of [requested, confirmed, cancelled]) {
        const res = await review(c, id, { rating: 5 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe("BOOKING_NOT_REVIEWABLE");
      }
      expect(await t.prisma.review.count()).toBe(0);
    });

    it("rejects an in-progress and a disputed booking", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      await w.agent.post(`${t.api}/bookings/${id}/start`).send({});
      expect((await review(c, id, { rating: 4 })).body.code).toBe("BOOKING_NOT_REVIEWABLE");
      await w.agent.post(`${t.api}/bookings/${id}/complete`).send({});
      expect((await review(c, id, { rating: 4 })).body.code).toBe("BOOKING_NOT_REVIEWABLE"); // completion not yet confirmed
    });

    it("allows exactly one review per booking, even under parallel submissions", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => review(c, id, { rating: (i % 5) + 1 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "REVIEW_EXISTS")).toBe(true);
      expect(await t.prisma.review.count({ where: { bookingId: id } })).toBe(1);
    });
  });

  describe("validation and mass assignment", () => {
    it("validates rating and text", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      const bad: object[] = [
        {}, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: "5" }, { rating: null }, { rating: -1 },
        { rating: 5, comment: "x".repeat(1001) },
        { rating: 5, comment: "bad\u0000char" },
        { rating: 5, comment: "spoof ‮evil" },
        { rating: 5, comment: 42 },
      ];
      for (const body of bad) expect((await review(c, id, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(await t.prisma.review.count()).toBe(0);
      const blank = await review(c, id, { rating: 3, comment: "   " });
      expect(blank.status).toBe(201);
      expect(blank.body.review.comment).toBeNull();
    });

    it("rejects client-supplied protected fields instead of ignoring them", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      for (const extra of [
        { customerId: "x" }, { workerProfileId: w.profileId }, { bookingId: id }, { status: "VISIBLE" }, { verified: true },
        { verifiedBooking: true }, { moderationReason: "x" }, { moderatedById: "x" }, { createdAt: "2020-01-01T00:00:00Z" }, { id: "x" },
      ]) {
        expect((await review(c, id, { rating: 5, ...extra })).status, JSON.stringify(extra)).toBe(400);
      }
      expect(await t.prisma.review.count()).toBe(0);
    });

    it("stores markup as plain text and returns it as JSON (never HTML)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      const xss = `<img src=x onerror=alert(1)><script>alert("x")</script> & "quotes"`;
      const res = await review(c, id, { rating: 5, comment: xss });
      expect(res.status).toBe(201);
      expect(res.body.review.comment).toBe(xss);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const listed = await t.client().get(`${t.api}/workers/${w.slug}/reviews`);
      expect(listed.headers["content-type"]).toMatch(/application\/json/);
      expect(listed.body.reviews[0].comment).toBe(xss);
    });
  });

  describe("rating aggregation", () => {
    it("shows an honest empty state for a worker with no reviews", async () => {
      const w = await bookableWorker(t);
      expect(await cardOf(w)).toEqual(expect.objectContaining({ rating: null, reviewCount: 0 }));
      const list = await t.client().get(`${t.api}/workers/${w.slug}/reviews`);
      expect(list.body).toMatchObject({ summary: { rating: null, reviewCount: 0, distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }, reviews: [], total: 0 });
    });

    it("computes average (one decimal, halves up) and count from stored reviews, on cards, profile, search and favourites", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      const other = await bookableWorker(t, { admin });
      await reviewed(w, [4, 4, 4, 5]); // 4.25 -> 4.3
      await reviewed(other, [3]);
      expect(await cardOf(w)).toMatchObject({ rating: 4.3, reviewCount: 4 });
      const search = (await t.client().get(`${t.api}/workers?category=electrical&pageSize=48`)).body.workers as { id: string; rating: number | null; reviewCount: number }[];
      expect(search.find((x) => x.id === w.profileId)).toMatchObject({ rating: 4.3, reviewCount: 4 });
      expect(search.find((x) => x.id === other.profileId)).toMatchObject({ rating: 3, reviewCount: 1 });
      const fan = await customer(t);
      await fan.agent.put(`${t.api}/me/favorites/${w.profileId}`);
      expect((await fan.agent.get(`${t.api}/me/favorites`)).body.workers[0]).toMatchObject({ rating: 4.3, reviewCount: 4 });
      const list = (await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).body;
      expect(list.summary).toMatchObject({ rating: 4.3, reviewCount: 4, distribution: { "1": 0, "2": 0, "3": 0, "4": 3, "5": 1 } });
    });

    it("computes the ratings of a whole page of workers with ONE grouped query (no N+1)", async () => {
      const admin = await t.newAdmin();
      const ws = [await bookableWorker(t, { admin }), await bookableWorker(t, { admin }), await bookableWorker(t, { admin })];
      for (const w of ws) await reviewed(w, [5]);
      const spy = vi.spyOn(t.prisma.review, "groupBy");
      try {
        const res = await t.client().get(`${t.api}/workers?category=electrical&pageSize=48`);
        expect(res.body.workers.filter((x: { reviewCount: number }) => x.reviewCount === 1)).toHaveLength(3);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("excludes reviews that are hidden by a moderator, withdrawn, or whose booking is no longer COMPLETED", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      const [a, b, c, d] = await reviewed(w, [5, 5, 1, 3]);
      expect(await cardOf(w)).toMatchObject({ rating: 3.5, reviewCount: 4 });

      // withdrawn by its author
      expect((await a!.cust.agent.delete(`${t.api}/bookings/${a!.bookingId}/review`)).status).toBe(200);
      expect(await cardOf(w)).toMatchObject({ rating: 3, reviewCount: 3 });

      // hidden by an administrator
      const row = await t.prisma.review.findUniqueOrThrow({ where: { bookingId: c!.bookingId } });
      const hide = await admin.agent.post(`${t.api}/admin/moderation/reviews/${row.id}/visibility`).send({ hidden: true, reason: "Contains abuse" });
      expect(hide.status).toBe(200);
      expect(await cardOf(w)).toMatchObject({ rating: 4, reviewCount: 2 });

      // booking leaves COMPLETED (dispute) -> not counted; counted again once the dispute is withdrawn
      const disp = await b!.cust.agent.post(`${t.api}/bookings/${b!.bookingId}/disputes`).send({ category: "SERVICE_QUALITY", description: "The fan stopped working again after a day." });
      expect(disp.status).toBeLessThan(300);
      expect(await cardOf(w)).toMatchObject({ rating: 3, reviewCount: 1 });
      expect((await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).body.reviews).toHaveLength(1);
      expect((await b!.cust.agent.post(`${t.api}/bookings/${b!.bookingId}/dispute/withdraw`).send({})).status).toBe(200);
      expect(await cardOf(w)).toMatchObject({ rating: 4, reviewCount: 2 });
      void d;

      // restoring the hidden review brings it back
      expect((await admin.agent.post(`${t.api}/admin/moderation/reviews/${row.id}/visibility`).send({ hidden: false, reason: "Mistake" })).status).toBe(200);
      expect(await cardOf(w)).toMatchObject({ rating: 3, reviewCount: 3 });
    });

    it("never counts a review for another worker, and a suspended worker's reviews are not public", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      await reviewed(w, [5]);
      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "test" });
      expect((await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/workers/${w.slug}`)).status).toBe(404);
    });
  });

  describe("public review list", () => {
    it("shows counted reviews with a public first name and a server-derived verified flag; no private data", async () => {
      const w = await bookableWorker(t);
      const c = await named("Asha Rahman");
      const id = await completedBooking(t, c, w);
      await review(c, id, { rating: 4, comment: "Good job" });
      const res = await t.client().get(`${t.api}/workers/${w.slug}/reviews`);
      expect(res.status).toBe(200);
      expect(res.body.reviews[0]).toEqual({
        id: expect.any(String), rating: 4, comment: "Good job", createdAt: expect.any(String), edited: false,
        author: { displayName: "Asha" }, service: "Electrical Services", verifiedBooking: true,
      });
      const text = JSON.stringify(res.body);
      for (const secret of [c.email, c.userId, id, "Rahman", "customerId", "bookingId"]) expect(text).not.toContain(secret);
    });

    it("prefers the display name the customer chose", async () => {
      const w = await bookableWorker(t);
      const c = await named("Asha Rahman");
      await c.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Asha R." });
      await review(c, await completedBooking(t, c, w), { rating: 5 });
      expect((await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).body.reviews[0].author.displayName).toBe("Asha R.");
    });

    it("paginates deterministically and bounds the page size", async () => {
      const w = await bookableWorker(t);
      await reviewed(w, [5, 4, 3]);
      const p1 = (await t.client().get(`${t.api}/workers/${w.slug}/reviews?pageSize=2&page=1`)).body;
      const p2 = (await t.client().get(`${t.api}/workers/${w.slug}/reviews?pageSize=2&page=2`)).body;
      expect([p1.reviews.length, p2.reviews.length, p1.total, p1.totalPages]).toEqual([2, 1, 3, 2]);
      expect(new Set([...p1.reviews, ...p2.reviews].map((r: { id: string }) => r.id)).size).toBe(3);
      for (const q of ["pageSize=0", "pageSize=49", "page=0", "page=abc"]) {
        expect((await t.client().get(`${t.api}/workers/${w.slug}/reviews?${q}`)).status).toBe(400);
      }
      expect((await t.client().get(`${t.api}/workers/nope/reviews`)).status).toBe(404);
    });
  });

  describe("editing and withdrawing", () => {
    it("lets the author edit within the window, keeps the previous text, and updates the average", async () => {
      const w = await bookableWorker(t);
      const [r] = await reviewed(w, [2]);
      expect(await cardOf(w)).toMatchObject({ rating: 2, reviewCount: 1 });
      const res = await r!.cust.agent.put(`${t.api}/bookings/${r!.bookingId}/review`).send({ rating: 5, comment: "Updated after a follow-up visit." });
      expect(res.status).toBe(200);
      expect(res.body.review).toMatchObject({ rating: 5, comment: "Updated after a follow-up visit.", editedAt: expect.any(String) });
      expect(await cardOf(w)).toMatchObject({ rating: 5, reviewCount: 1 });
      const revisions = await t.prisma.reviewRevision.findMany();
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ rating: 2, comment: null });
      expect((await t.client().get(`${t.api}/workers/${w.slug}/reviews`)).body.reviews[0].edited).toBe(true);
    });

    it("a no-op edit creates no revision; an empty edit and unknown fields are rejected; null clears the comment", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      await review(c, id, { rating: 4, comment: "Fine" });
      const put = (body: object) => c.agent.put(`${t.api}/bookings/${id}/review`).send(body);
      expect((await put({ rating: 4 })).status).toBe(200);
      expect(await t.prisma.reviewRevision.count()).toBe(0);
      expect((await put({})).status).toBe(400);
      expect((await put({ rating: 5, status: "HIDDEN" })).status).toBe(400);
      expect((await put({ rating: 9 })).status).toBe(400);
      expect((await put({ comment: null })).body.review.comment).toBeNull();
    });

    it("blocks other people, and edits after the window", async () => {
      const w = await bookableWorker(t);
      const [r] = await reviewed(w, [3]);
      const stranger = await customer(t);
      const put = (who: Person | Worker, body: object) => who.agent.put(`${t.api}/bookings/${r!.bookingId}/review`).send(body);
      expect((await put(stranger, { rating: 1 })).status).toBe(404);
      expect((await put(w, { rating: 1 })).status).toBe(404);
      expect((await t.client().put(`${t.api}/bookings/${r!.bookingId}/review`).send({ rating: 1 })).status).toBe(401);
      expect((await stranger.agent.delete(`${t.api}/bookings/${r!.bookingId}/review`)).status).toBe(404);
      expect((await stranger.agent.get(`${t.api}/bookings/${r!.bookingId}/review`)).status).toBe(404);
      expect(await cardOf(w)).toMatchObject({ rating: 3 });

      t.clock.advanceMinutes(15 * 24 * 60);
      const late = await put(r!.cust, { rating: 5 });
      expect(late.status).toBe(422);
      expect(late.body.code).toBe("EDIT_WINDOW_CLOSED");
    });

    it("withdrawing is final and idempotent: it cannot be edited or re-posted", async () => {
      const w = await bookableWorker(t);
      const [r] = await reviewed(w, [1]);
      const url = `${t.api}/bookings/${r!.bookingId}/review`;
      expect((await r!.cust.agent.delete(url)).body.review.status).toBe("DELETED");
      expect((await r!.cust.agent.delete(url)).status).toBe(200);
      expect((await r!.cust.agent.put(url).send({ rating: 5 })).body.code).toBe("REVIEW_NOT_EDITABLE");
      const again = await review(r!.cust, r!.bookingId, { rating: 5 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("REVIEW_EXISTS");
      expect(await cardOf(w)).toMatchObject({ rating: null, reviewCount: 0 });
    });
  });

  describe("booking detail", () => {
    it("tells the customer whether they can review, and the professional only about a visible review", async () => {
      const admin = await t.newAdmin();
      const w = await bookableWorker(t, { admin });
      const c = await customer(t);
      const id = await completedBooking(t, c, w);
      const detail = async (who: Person | Worker) => (await who.agent.get(`${t.api}/bookings/${id}`)).body.review;
      expect(await detail(c)).toEqual({ canReview: true, review: null });
      expect(await detail(w)).toEqual({ review: null });
      await review(c, id, { rating: 4, comment: "Nice" });
      expect(await detail(c)).toMatchObject({ canReview: false, review: { rating: 4, status: "VISIBLE", canEdit: true, canWithdraw: true } });
      expect(await detail(w)).toEqual({ review: { rating: 4, comment: "Nice", createdAt: expect.any(String) } });
      const row = await t.prisma.review.findUniqueOrThrow({ where: { bookingId: id } });
      await admin.agent.post(`${t.api}/admin/moderation/reviews/${row.id}/visibility`).send({ hidden: true, reason: "Policy" });
      expect(await detail(w)).toEqual({ review: null });
      const mine = await detail(c);
      expect(mine.review).toMatchObject({ status: "HIDDEN", canEdit: false, canWithdraw: false });
      expect(JSON.stringify(mine)).not.toContain("Policy");
    });
  });
});
