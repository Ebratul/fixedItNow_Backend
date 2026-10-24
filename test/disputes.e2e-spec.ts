import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, confirmedBooking, customer, requestBooking, type Person, type Worker } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("disputes", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const DESC = "The work was not finished and the fan still makes noise.";
  const open = (who: Person | Worker, id: string, extra: object = {}) =>
    who.agent.post(`${t.api}/bookings/${id}/disputes`).send({ category: "SERVICE_QUALITY", description: DESC, ...extra });
  const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
  const admin = async () => t.newAdmin();
  const adminPost = (a: Person, id: string, verb: string, body: object = {}) => a.agent.post(`${t.api}/admin/disputes/${id}/${verb}`).send(body);

  /** CONFIRMED -> IN_PROGRESS -> COMPLETION_PENDING (-> COMPLETED) with the clock at the appointment. */
  async function jobAt(stage: "in_progress" | "pending" | "completed") {
    const w = await bookableWorker(t);
    const c = await customer(t);
    const start = at(t, 3, 10);
    const id = await confirmedBooking(t, c, w, start);
    t.clock.set(start);
    await w.agent.post(`${t.api}/bookings/${id}/start`).send({});
    if (stage !== "in_progress") await w.agent.post(`${t.api}/bookings/${id}/complete`).send({});
    if (stage === "completed") await c.agent.post(`${t.api}/bookings/${id}/confirm-completion`).send({});
    return { w, c, id };
  }
  const disputed = async (stage: "in_progress" | "pending" | "completed" = "completed") => {
    const job = await jobAt(stage);
    const res = await open(job.c, job.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dispute = await t.prisma.dispute.findUniqueOrThrow({ where: { bookingId: job.id } });
    return { ...job, disputeId: dispute.id };
  };

  describe("opening", () => {
    it.each(["in_progress", "pending", "completed"] as const)("a party can dispute a job that is %s", async (stage) => {
      const { w, c, id } = await jobAt(stage);
      const res = await open(stage === "in_progress" ? w : c, id, { category: "PRICE_DISAGREEMENT" });
      expect(res.body.booking.status).toBe("DISPUTED");
      expect(res.body.dispute).toMatchObject({ status: "OPEN", category: "PRICE_DISAGREEMENT", openedByRole: stage === "in_progress" ? "WORKER" : "CUSTOMER" });
      expect((await t.prisma.dispute.findUniqueOrThrow({ where: { bookingId: id } })).previousBookingStatus).toBe(stage === "in_progress" ? "IN_PROGRESS" : stage === "pending" ? "COMPLETION_PENDING" : "COMPLETED");
      expect(res.body.actions).toEqual([]); // nothing else can be done to a disputed booking
    });

    it("a confirmed booking can be disputed only after its start time has passed (no-show)", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const start = at(t, 3, 10);
      const id = await confirmedBooking(t, c, w, start);
      expect((await open(c, id, { category: "NO_SHOW" })).body.code).toBe("DISPUTE_NOT_ALLOWED");
      t.clock.set(new Date(start.getTime() + 30 * 60_000));
      expect((await open(c, id, { category: "NO_SHOW" })).status).toBe(200);
    });

    it("is not allowed for requests, cancelled bookings, or after the 14-day window", async () => {
      const w = await bookableWorker(t);
      const c = await customer(t);
      const requested = (await requestBooking(t, c, w, at(t, 3, 10))).body.booking.id;
      expect((await open(c, requested)).body.code).toBe("DISPUTE_NOT_ALLOWED");
      const cancelled = await confirmedBooking(t, c, w, at(t, 4, 10));
      await c.agent.post(`${t.api}/bookings/${cancelled}/cancel`).send({ reason: "No longer needed" });
      expect((await open(c, cancelled)).status).toBe(409);

      const job = await jobAt("completed");
      t.clock.advanceMinutes(15 * 24 * 60);
      expect((await open(job.c, job.id)).body.code).toBe("DISPUTE_NOT_ALLOWED");
      t.clock.set(new Date(t.clock.now().getTime() - 2 * 24 * 3_600_000)); // inside the window again
      expect((await open(job.c, job.id)).status).toBe(200);
    });

    it("only one dispute per booking", async () => {
      const { w, c, id } = await disputed("completed");
      expect((await open(w, id)).status).toBe(409);
      expect((await open(c, id)).status).toBe(409);
      expect(await t.prisma.dispute.count()).toBe(1);
    });

    it("only the booking's customer or worker can open one; strangers and anonymous get 404/401", async () => {
      const { id } = await jobAt("completed");
      const stranger = await customer(t);
      const otherWorker = await bookableWorker(t);
      expect((await open(stranger, id)).status).toBe(404);
      expect((await open(otherWorker, id)).status).toBe(404);
      expect((await t.client().post(`${t.api}/bookings/${id}/disputes`).send({ category: "OTHER", description: DESC })).status).toBe(401);
      expect(await t.prisma.dispute.count()).toBe(0);
    });

    it.each([
      ["a short description", { description: "bad" }],
      ["an over-long description", { description: "x".repeat(2001) }],
      ["an unknown category", { category: "FRAUD" }],
      ["evidence attachments (not supported yet)", { evidenceKeys: ["private/x.jpg"] }],
      ["an admin flag", { isAdmin: true }],
      ["a status", { status: "RESOLVED" }],
    ])("rejects %s", async (_n, extra) => {
      const { c, id } = await jobAt("completed");
      expect((await open(c, id, extra)).status).toBe(400);
      expect(await t.prisma.dispute.count()).toBe(0);
    });

    it("a disputed booking cannot be silently completed, cancelled or restarted by either party", async () => {
      const { w, c, id } = await disputed("pending");
      for (const [who, action, body] of [
        [c, "confirm-completion", {}], [w, "complete", {}], [w, "start", {}],
        [c, "cancel", { reason: "Trying to cancel anyway" }], [w, "cancel", { reason: "Trying to cancel anyway" }],
      ] as const) {
        expect((await who.agent.post(`${t.api}/bookings/${id}/${action}`).send(body)).status, action).toBe(409);
      }
      expect((await row(id)).status).toBe("DISPUTED");
    });
  });

  describe("what each side can see", () => {
    it("participants see the dispute and public messages, never internal notes or admin identities", async () => {
      const { w, c, id, disputeId } = await disputed();
      const a = await admin();
      await adminPost(a, disputeId, "review");
      await adminPost(a, disputeId, "messages", { body: "Please describe what is wrong.", internal: false });
      await adminPost(a, disputeId, "messages", { body: "INTERNAL: customer looks credible", internal: true });
      for (const who of [c, w]) {
        const res = await who.agent.get(`${t.api}/bookings/${id}/dispute`);
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text).toContain("Please describe what is wrong.");
        expect(text).not.toContain("INTERNAL");
        expect(text).not.toMatch(/assignedAdmin|resolvedByUserId|openedByUserId|authorUserId|internal/);
      }
      // The admin sees everything, including internal notes.
      const adminView = (await a.agent.get(`${t.api}/admin/disputes/${disputeId}`)).body;
      expect(adminView.dispute.messages.map((m: any) => m.internal)).toEqual([false, true]);
    });

    it("unrelated users cannot read or write on someone else's dispute", async () => {
      const { id } = await disputed();
      const stranger = await customer(t);
      const otherWorker = await bookableWorker(t);
      for (const who of [stranger, otherWorker]) {
        expect((await who.agent.get(`${t.api}/bookings/${id}/dispute`)).status).toBe(404);
        expect((await who.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "hello there" })).status).toBe(404);
        expect((await who.agent.post(`${t.api}/bookings/${id}/dispute/withdraw`).send({})).status).toBe(404);
      }
      expect((await t.client().get(`${t.api}/bookings/${id}/dispute`)).status).toBe(401);
    });
  });

  describe("messages and withdrawal", () => {
    it("both parties can add text messages while the dispute is active", async () => {
      const { w, c, id } = await disputed();
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "Here is more detail." })).status).toBe(200);
      expect((await w.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "I disagree with that." })).status).toBe(200);
      const msgs = (await c.agent.get(`${t.api}/bookings/${id}/dispute`)).body.dispute.messages;
      expect(msgs.map((m: any) => m.authorRole)).toEqual(["CUSTOMER", "WORKER"]);
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "" })).status).toBe(400);
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "x".repeat(2001) })).status).toBe(400);
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "hi there", file: "x" })).status).toBe(400);
    });

    it("the opener can withdraw: the dispute closes and the booking returns to its previous status", async () => {
      const { w, c, id } = await disputed("completed");
      expect((await w.agent.post(`${t.api}/bookings/${id}/dispute/withdraw`).send({})).status).toBe(403); // not the opener
      const res = await c.agent.post(`${t.api}/bookings/${id}/dispute/withdraw`).send({});
      expect(res.body.booking.status).toBe("COMPLETED");
      expect(res.body.dispute.status).toBe("CLOSED");
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/withdraw`).send({})).status).toBe(409);
      expect((await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "still here?" })).body.code).toBe("DISPUTE_CLOSED");
    });
  });

  describe("administrative workflow", () => {
    it("only admins can list or act; the role comes from the database, not the request", async () => {
      const { c, w, disputeId } = await disputed();
      const anon = t.client();
      for (const who of [c, w]) {
        expect((await who.agent.get(`${t.api}/admin/disputes`)).status).toBe(403);
        expect((await who.agent.get(`${t.api}/admin/disputes/${disputeId}`)).status).toBe(403);
        expect((await who.agent.post(`${t.api}/admin/disputes/${disputeId}/resolve`).send({ outcome: "CANCEL_BOOKING", resolution: "I decide this myself" })).status).toBe(403);
        expect((await who.agent.post(`${t.api}/admin/disputes/${disputeId}/review`).set("X-Admin", "true").send({ isAdmin: true })).status).toBe(403); // flags in the request are ignored
      }
      expect((await anon.get(`${t.api}/admin/disputes`)).status).toBe(401);
      expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("OPEN");
    });

    it("walks OPEN -> UNDER_REVIEW -> WAITING -> UNDER_REVIEW (on reply) -> RESOLVED, with audit entries", async () => {
      const { c, id, disputeId } = await disputed();
      const a = await admin();
      expect((await a.agent.get(`${t.api}/admin/disputes?status=OPEN`)).body.disputes.map((d: any) => d.id)).toEqual([disputeId]);

      expect((await adminPost(a, disputeId, "review")).body.dispute).toMatchObject({ status: "UNDER_REVIEW", assignedAdminId: a.userId });
      expect((await adminPost(a, disputeId, "request-info", { message: "Please send the exact problem." })).body.dispute.status).toBe("WAITING_FOR_INFORMATION");
      await c.agent.post(`${t.api}/bookings/${id}/dispute/messages`).send({ body: "The fan wobbles and sparks." });
      expect((await a.agent.get(`${t.api}/admin/disputes/${disputeId}`)).body.dispute.status).toBe("UNDER_REVIEW");

      const res = await adminPost(a, disputeId, "resolve", { outcome: "MARK_COMPLETED", resolution: "Work completed; minor issue noted for the worker." });
      expect(res.status).toBe(200);
      expect(res.body.dispute).toMatchObject({ status: "RESOLVED", outcome: "MARK_COMPLETED" });
      expect((await row(id)).status).toBe("COMPLETED");
      const actions = (await t.prisma.auditLog.findMany({ where: { targetId: disputeId }, orderBy: { createdAt: "asc" } })).map((e) => [e.action, e.actorId === a.userId]);
      expect(actions).toEqual([["dispute.review", true], ["dispute.request_info", true], ["dispute.resolve", true]]);
      const party = (await c.agent.get(`${t.api}/bookings/${id}/dispute`)).body.dispute;
      expect(party).toMatchObject({ status: "RESOLVED", resolution: "Work completed; minor issue noted for the worker." });
    });

    it.each([
      ["MARK_COMPLETED", "COMPLETED"],
      ["CANCEL_BOOKING", "CANCELLED"],
      ["RESTORE_BOOKING", "COMPLETION_PENDING"],
    ] as const)("resolving with %s sets the booking to %s", async (outcome, expected) => {
      const { id, disputeId } = await disputed("pending");
      const a = await admin();
      await adminPost(a, disputeId, "review");
      const res = await adminPost(a, disputeId, "resolve", { outcome, resolution: "Decision recorded after review." });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const b = await row(id);
      expect(b.status).toBe(expected);
      if (outcome === "CANCEL_BOOKING") expect(b.cancelledByUserId).toBe(a.userId);
    });

    it("rejecting a dispute restores the booking", async () => {
      const { id, disputeId } = await disputed("completed");
      const a = await admin();
      await adminPost(a, disputeId, "review");
      const res = await adminPost(a, disputeId, "reject", { resolution: "No evidence of a problem." });
      expect(res.body.dispute.status).toBe("REJECTED");
      expect((await row(id)).status).toBe("COMPLETED");
    });

    it("rejects invalid dispute transitions and validates input", async () => {
      const { disputeId } = await disputed();
      const a = await admin();
      // Cannot resolve before it is under review.
      expect((await adminPost(a, disputeId, "resolve", { outcome: "MARK_COMPLETED", resolution: "Too early to decide." })).body.code).toBe("INVALID_DISPUTE_TRANSITION");
      expect((await adminPost(a, disputeId, "request-info", { message: "Tell me more please" })).status).toBe(409);
      await adminPost(a, disputeId, "review");
      expect((await adminPost(a, disputeId, "review")).status).toBe(409);
      expect((await adminPost(a, disputeId, "resolve", { outcome: "REFUND", resolution: "Giving money back." })).status).toBe(400); // no payment outcomes exist
      expect((await adminPost(a, disputeId, "resolve", { outcome: "MARK_COMPLETED", resolution: "short" })).status).toBe(400);
      await adminPost(a, disputeId, "resolve", { outcome: "MARK_COMPLETED", resolution: "Resolved after careful review." });
      for (const [verb, body] of [["review", {}], ["reject", { resolution: "Trying to reject afterwards." }], ["resolve", { outcome: "CANCEL_BOOKING", resolution: "Trying to change the outcome." }], ["request-info", { message: "Anything more at all?" }]] as const) {
        expect((await adminPost(a, disputeId, verb, body)).status, verb).toBe(409);
      }
      expect((await adminPost(a, "0192a000-0000-7000-8000-000000000000", "review")).status).toBe(404);
    });

    it("an admin who is part of the booking cannot moderate it", async () => {
      const { c, id, disputeId } = await disputed();
      void id;
      await t.makeAdmin(c.userId);
      const res = await adminPost(c, disputeId, "review");
      expect(res.status).toBe(403);
      expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("OPEN");
    });

    it("restoring into a slot that was taken fails with 409 and leaves everything as it was", async () => {
      const { w, id, disputeId } = await disputed("in_progress");
      const category = await t.prisma.serviceCategory.findFirstOrThrow({ where: { slug: "electrical" } });
      const original = await row(id);
      // While DISPUTED the slot is not reserved; another confirmed booking lands on it.
      await t.prisma.booking.create({
        data: {
          customerId: (await customer(t)).userId, workerProfileId: w.profileId, categoryId: category.id, status: "CONFIRMED",
          description: "raw", serviceArea: "Dhaka", serviceAddress: "x", startAt: original.startAt, endAt: original.endAt,
          durationMinutes: 60, pricingModel: "FIXED", pricingSnapshot: {},
        },
      });
      const a = await admin();
      await adminPost(a, disputeId, "review");
      const res = await adminPost(a, disputeId, "resolve", { outcome: "RESTORE_BOOKING", resolution: "Restoring the job to progress." });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SLOT_UNAVAILABLE");
      expect((await row(id)).status).toBe("DISPUTED");
      expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("UNDER_REVIEW");
      // The admin can still choose another outcome.
      expect((await adminPost(a, disputeId, "resolve", { outcome: "MARK_COMPLETED", resolution: "Marking it completed instead." })).status).toBe(200);
    });

    it("does not leak emails or account identifiers to admins", async () => {
      const { c, w, disputeId } = await disputed();
      const a = await admin();
      const text = JSON.stringify((await a.agent.get(`${t.api}/admin/disputes/${disputeId}`)).body);
      for (const secret of [c.email, w.email, c.userId, w.userId]) expect(text).not.toContain(secret);
    });
  });
});
