import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_PROFILES } from "../src/demo/demo.config.js";
import { resetDemoData } from "../src/demo/demo.reset.js";
import { seedDemo } from "../src/demo/demo.fixtures.js";
import { at, bookableWorker, completedBooking, confirmedBooking, customer, type Person, type Worker } from "./booking-helpers.js";
import { allDemoOn, demoSession, seedDemoData, setDemoSwitches } from "./demo-helpers.js";
import { TEST_ENV } from "./fake-providers.js";
import { createTestApp, WEB_ORIGIN, type TestApp } from "./helpers.js";

/**
 * What a visitor can actually DO in the demo: the booking -> chat -> arrival -> payment -> review workflow end to end as
 * the demo customer and the demo worker, with the SIMULATED payment, and what the demo must never do (touch a real booking,
 * call a payment provider, send mail). Plus the operator tools: the seed (idempotent) and the reset (demo rows only).
 */
describe("demo workflow, simulated payments and operator tools", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(TEST_ENV); }); // bKash IS configured (against the mock): the demo must still never reach it
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetData();
    await seedDemoData(t);
    await setDemoSwitches(t, allDemoOn);
  });

  const u = () => t.prisma.unscoped;
  const status = async (id: string) => (await u().booking.findUniqueOrThrow({ where: { id } })).status;
  const seeded = async (key: string) => (await u().booking.findFirstOrThrow({ where: { idempotencyKey: `demo-seed-${key}` } })).id;

  async function both() {
    const c = await demoSession(t, "customer");
    const w = await demoSession(t, "worker");
    return { c, w };
  }

  describe("the full lifecycle as the demo customer and the demo worker", () => {
    it("request -> accept -> chat -> arrive -> start -> finish -> simulated payment -> completed -> review", async () => {
      const { c, w } = await both();
      const profile = await u().workerProfile.findFirstOrThrow({ where: { user: { demoRole: "WORKER" } } });
      const start = at(t, 4, 14); // Thursday 14:00, inside the demo worker's Sunday-Thursday hours

      // the customer finds the demo professional and sees real-looking slots
      const slots = await c.agent.get(`${t.api}/workers/${profile.slug}/availability?days=7&duration=60`);
      expect(slots.status).toBe(200);

      const created = await c.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "demo-flow-0001").send({
        workerId: profile.id, categorySlug: "electrical", description: "Two sockets in the study stopped working.", serviceArea: "Dhaka",
        serviceAddress: "House 12, Road 5, Demo Residential Area", startAt: start.toISOString(), durationMinutes: 60,
      });
      expect(created.status).toBe(201);
      const id = created.body.booking.id as string;
      expect(created.body.booking.status).toBe("REQUESTED");

      // the worker sees it and accepts; the customer is told
      const incoming = await w.agent.get(`${t.api}/bookings?role=worker&group=open&pageSize=30`);
      expect(JSON.stringify(incoming.body)).toContain(id);
      expect((await w.agent.post(`${t.api}/bookings/${id}/accept`).send({})).body.booking.status).toBe("CONFIRMED");
      expect(await u().notification.count({ where: { userId: c.userId, type: "booking.accepted" } })).toBeGreaterThan(0);

      // booking-linked chat: both participants, nobody else
      expect((await c.agent.post(`${t.api}/bookings/${id}/chat/messages`).send({ body: "The gate code is 1234 (demo).", clientMessageId: "demo-chat-0001" })).status).toBe(201);
      expect((await w.agent.post(`${t.api}/bookings/${id}/chat/messages`).send({ body: "On my way tomorrow.", clientMessageId: "demo-chat-0002" })).status).toBe(201);
      const chat = await c.agent.get(`${t.api}/bookings/${id}/chat`);
      expect((chat.body.messages as { body: string }[]).map((m) => m.body)).toEqual(["The gate code is 1234 (demo).", "On my way tomorrow."]);
      const admin = await demoSession(t, "admin");
      expect((await admin.agent.get(`${t.api}/bookings/${id}/chat`)).status).toBe(404);
      expect((await admin.agent.post(`${t.api}/bookings/${id}/chat/messages`).send({ body: "hi", clientMessageId: "demo-chat-0003" })).status).toBe(403); // demo admin is read-only
      const otherBooking = await seeded("b5-completed");
      expect((await c.agent.get(`${t.api}/bookings/${otherBooking}/chat`)).status).toBe(200); // the demo customer's own, older booking
      const stranger = await u().booking.findFirstOrThrow({ where: { idempotencyKey: "demo-seed-c1-completed" } });
      expect((await c.agent.get(`${t.api}/bookings/${stranger.id}/chat`)).status).toBe(404); // another demo customer's record

      // arrival, work, completion: payment becomes due
      t.clock.set(new Date(start.getTime() - 10 * 60_000));
      expect((await w.agent.post(`${t.api}/bookings/${id}/arrive`).send({})).status).toBe(200);
      expect((await w.agent.post(`${t.api}/bookings/${id}/start`).send({})).status).toBe(200);
      expect((await w.agent.post(`${t.api}/bookings/${id}/complete`).send({})).body.booking.status).toBe("COMPLETION_PENDING");

      // PAYMENT: only the simulation is offered, and bKash is out of reach even though it is configured
      const providers = await c.agent.get(`${t.api}/payments/providers`);
      expect(providers.body.providers).toEqual([expect.objectContaining({ provider: "DEMO", mode: "simulated", available: true })]);
      const bkash = await c.agent.post(`${t.api}/bookings/${id}/payments`).send({ provider: "BKASH" });
      expect(bkash.status).toBe(422);
      expect(bkash.body.code).toBe("DEMO_SIMULATED_ONLY");
      const started = await c.agent.post(`${t.api}/bookings/${id}/payments`).set("Idempotency-Key", "demo-pay-0001").send({ provider: "DEMO" });
      expect(started.status).toBe(201);
      const reference = started.body.payment.reference as string;
      expect(started.body.checkoutUrl).toBe(`${WEB_ORIGIN}/payments/demo/${reference}`);
      expect(started.body.payment).toMatchObject({ provider: "DEMO", mode: "simulated", status: "INITIATED" });
      expect(await status(id)).toBe("COMPLETION_PENDING"); // a started payment completes nothing

      // a failed simulated payment can be retried; only a successful one completes the booking
      const failed = await c.agent.post(`${t.api}/payments/${reference}/demo-outcome`).send({ outcome: "failed" });
      expect(failed.body.payment.status).toBe("FAILED");
      expect(await status(id)).toBe("COMPLETION_PENDING");
      const retry = await c.agent.post(`${t.api}/bookings/${id}/payments`).set("Idempotency-Key", "demo-pay-0002").send({ provider: "DEMO" });
      expect([retry.status, retry.body.code]).toEqual([201, undefined]);
      const second = retry.body.payment.reference as string;
      const paid = await c.agent.post(`${t.api}/payments/${second}/demo-outcome`).send({ outcome: "success" });
      expect(paid.status).toBe(200);
      expect(paid.body.payment).toMatchObject({ status: "SUCCEEDED", provider: "DEMO", mode: "simulated", providerTransactionId: `DEMO-${second}` });
      expect(await status(id)).toBe("COMPLETED");
      expect((await u().bookingEvent.findMany({ where: { bookingId: id } })).map((e) => e.type)).toEqual(expect.arrayContaining(["booking.requested", "booking.accepted", "booking.arrived", "booking.started", "payment.verified", "booking.completed"]));
      // the worker sees the completed booking and its verified (simulated) payment
      const asWorker = await w.agent.get(`${t.api}/bookings/${id}`);
      expect(asWorker.body.booking.status).toBe("COMPLETED");

      // a settled simulated payment cannot be settled again, and the client cannot dictate the status
      expect((await c.agent.post(`${t.api}/payments/${second}/demo-outcome`).send({ outcome: "success" })).status).toBe(409);
      expect((await c.agent.post(`${t.api}/payments/${second}/demo-outcome`).send({ outcome: "success", status: "SUCCEEDED", amountBdt: 1 })).status).toBe(400);
      expect((await c.agent.post(`${t.api}/payments/${second}/demo-outcome`).send({ outcome: "refunded" })).status).toBe(400);

      // review, then the rating shows in the DEMO directory (and only there)
      const review = await c.agent.post(`${t.api}/bookings/${id}/review`).send({ rating: 4, comment: "Tidy work, fictional review." });
      expect(review.status).toBe(201);
      const card = (await c.agent.get(`${t.api}/workers/${profile.slug}`)).body.worker;
      expect(card.reviewCount).toBeGreaterThanOrEqual(2);
      expect((await t.client().get(`${t.api}/workers/${profile.slug}`)).status).toBe(404);

      // refunds keep their normal rules: a completed booking is not refundable (the demo bypasses nothing), while the seeded
      // cancelled-after-paying booking already has a refund request waiting for an administrator, visible to its customer
      const ineligible = await c.agent.post(`${t.api}/payments/${second}/refunds`).send({ reason: "The demo customer changed their mind." });
      expect([ineligible.status, ineligible.body.code]).toEqual([422, "REFUND_NOT_ELIGIBLE"]);
      const cancelledPayment = await u().payment.findFirstOrThrow({ where: { booking: { idempotencyKey: "demo-seed-b6-cancelled" } } });
      const seededRefund = await c.agent.get(`${t.api}/payments/${cancelledPayment.reference}`);
      expect(seededRefund.body.payment).toMatchObject({ provider: "DEMO", needsAttention: true });
      expect(seededRefund.body.payment.refunds).toEqual([expect.objectContaining({ status: "REQUESTED" })]);
      expect((await u().payment.findUniqueOrThrow({ where: { reference: second } })).status).toBe("SUCCEEDED");

      // NO SIDE EFFECT left the system: no provider call and no email, for the whole flow
      expect(t.net.calls).toEqual([]);
      expect(t.mail.outbox).toEqual([]);
      expect(await t.prisma.payment.count()).toBe(0); // the real realm has no payment at all
    });

    it("pays the seeded 'payment due' booking and the booking completes, then it can be reviewed", async () => {
      const { c } = await both();
      const id = await seeded("b4-payment-due");
      expect(await status(id)).toBe("COMPLETION_PENDING");
      const start = await c.agent.post(`${t.api}/bookings/${id}/payments`).send({ provider: "DEMO" });
      expect(start.status).toBe(201);
      await c.agent.post(`${t.api}/payments/${start.body.payment.reference}/demo-outcome`).send({ outcome: "success" });
      expect(await status(id)).toBe("COMPLETED");
      expect((await c.agent.post(`${t.api}/bookings/${id}/review`).send({ rating: 5, comment: "Great, fictional." })).status).toBe(201);
    });

    it("the worker side: accept and decline requests, send a quote the customer accepts", async () => {
      const { c, w } = await both();
      const requested = await seeded("b1-requested");
      const quoted = await seeded("b2-quoted");
      expect((await w.agent.post(`${t.api}/bookings/${requested}/decline`).send({ reason: "Fully booked that day (demo)." })).body.booking.status).toBe("DECLINED");
      // the seeded quote is pending: the customer accepts it and the booking is confirmed
      const quote = await u().quote.findFirstOrThrow({ where: { bookingId: quoted, status: "PENDING" } });
      const accepted = await c.agent.post(`${t.api}/bookings/${quoted}/quotes/${quote.id}/accept`).send({ expectedTotalBdt: quote.totalBdt });
      expect(accepted.status).toBe(200);
      expect(await status(quoted)).toBe("CONFIRMED");
      const mine = await w.agent.get(`${t.api}/bookings?role=worker&group=active&pageSize=30`);
      expect(JSON.stringify(mine.body)).toContain(quoted);
    });

    it("a simulated payment cannot reach a real booking, and a real payment cannot be driven by a demo outcome", async () => {
      const { c } = await both();
      const realWorker: Worker = await bookableWorker(t);
      const realCustomer: Person = await customer(t);
      const realBooking = await confirmedBooking(t, realCustomer, realWorker, at(t, 6, 10));
      const demoPayable = await seeded("b4-payment-due");
      // a demo customer cannot even name a real booking
      expect((await c.agent.post(`${t.api}/bookings/${realBooking}/payments`).send({ provider: "DEMO" })).status).toBe(404);
      // a real customer cannot use the simulation
      const asReal = await realCustomer.agent.post(`${t.api}/bookings/${realBooking}/payments`).send({ provider: "DEMO" });
      expect(asReal.status).toBe(422);
      expect(asReal.body.code).toBe("PROVIDER_UNAVAILABLE");
      expect((await realCustomer.agent.get(`${t.api}/payments/providers`)).body.providers).toEqual([expect.objectContaining({ provider: "BKASH" })]);
      // ...and a demo outcome sent for the simulated payment by anyone but its demo customer is a 404
      const start = await c.agent.post(`${t.api}/bookings/${demoPayable}/payments`).send({ provider: "DEMO" });
      const ref = start.body.payment.reference as string;
      expect((await realCustomer.agent.post(`${t.api}/payments/${ref}/demo-outcome`).send({ outcome: "success" })).status).toBe(404);
      const worker = await demoSession(t, "worker");
      expect((await worker.agent.post(`${t.api}/payments/${ref}/demo-outcome`).send({ outcome: "success" })).status).toBe(404);
      expect(await status(realBooking)).toBe("CONFIRMED");
      expect(await t.prisma.payment.count({ where: { bookingId: realBooking } })).toBe(0);
      expect(t.net.calls).toEqual([]);
    });

    it("real bKash payments keep working beside the demo (the demo changes nothing for ordinary users)", async () => {
      await demoSession(t, "customer");
      const realWorker = await bookableWorker(t);
      const realCustomer = await customer(t);
      const id = await completedBooking(t, realCustomer, realWorker);
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
      const payment = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: id } });
      expect(payment).toMatchObject({ provider: "BKASH", status: "SUCCEEDED" });
      expect(t.net.callsTo("tokenized.sandbox.bka.sh").length).toBeGreaterThan(0); // the mock was used for the REAL payment only
    });
  });

  describe("the seed", () => {
    it("is idempotent: a second run adds nothing, and never undoes what visitors did", async () => {
      const first = await u().booking.count({ where: { customer: { isDemo: true } } });
      const { c } = await both();
      const requested = await seeded("b1-requested");
      expect((await c.agent.post(`${t.api}/bookings/${requested}/cancel`).send({ reason: "Changed my mind (demo)." })).status).toBe(200);
      const again = await seedDemo(u(), { now: t.clock.now() });
      expect(again.created).toEqual({ users: 0, bookings: 0, other: 0 });
      expect(await u().booking.count({ where: { customer: { isDemo: true } } })).toBe(first);
      expect(await status(requested)).toBe("CANCELLED"); // not reset
      expect(await u().user.count({ where: { isDemo: true } })).toBe(11);
    });

    it("creates the three identities with no credentials, fictional addresses and consistent data", async () => {
      const users = await u().user.findMany({ where: { isDemo: true }, include: { accounts: true } });
      expect(users).toHaveLength(11);
      expect(users.every((x) => x.emailVerified && x.accounts.length === 0 && x.email.endsWith(".invalid"))).toBe(true);
      expect((await u().user.findMany({ where: { demoRole: { not: null } }, orderBy: { demoRole: "asc" } })).map((x) => [x.demoRole, x.email, x.role])).toEqual([
        ["CUSTOMER", DEMO_PROFILES.customer.email, "USER"], ["WORKER", DEMO_PROFILES.worker.email, "USER"], ["ADMIN", DEMO_PROFILES.admin.email, "ADMIN"],
      ]);
      // every kind of record the screens need exists, in every state the workflow has
      const bookings = await u().booking.groupBy({ by: ["status"], where: { customer: { isDemo: true } }, _count: { _all: true } });
      expect(bookings.map((b) => b.status).sort()).toEqual(["CANCELLED", "COMPLETED", "COMPLETION_PENDING", "CONFIRMED", "DISPUTED", "QUOTED", "REQUESTED"]);
      expect(await u().chatMessage.count()).toBeGreaterThan(5);
      expect(await u().review.count()).toBe(5);
      expect(await u().dispute.count()).toBe(1);
      expect(await u().refund.count({ where: { status: "REQUESTED" } })).toBe(1);
      expect(await u().payment.count({ where: { provider: "DEMO", status: "SUCCEEDED" } })).toBeGreaterThanOrEqual(6);
      expect(await u().workerProfile.count({ where: { verificationStatus: "PENDING" } })).toBe(1); // something to verify
      expect(await u().contentReport.count()).toBe(1);
      expect(await u().supportTicket.count()).toBe(2);
      // no NID, phone, or payment credential anywhere
      expect(await u().workerDocument.count()).toBe(0);
    });

    it("refuses to seed over a reserved demo address that belongs to an ordinary account", async () => {
      await t.resetData();
      await u().user.create({ data: { id: "squatter", name: "Squatter", email: DEMO_PROFILES.customer.email, emailVerified: true } });
      await expect(seedDemo(u(), { now: t.clock.now() })).rejects.toThrow(/non-demo account/);
    });
  });

  describe("the reset", () => {
    it("removes demo records only, leaves every real record alone, and puts the append-only guards back", async () => {
      // real data of every kind the reset touches in the demo realm
      const realWorker = await bookableWorker(t);
      const realCustomer = await customer(t);
      const realBooking = await completedBooking(t, realCustomer, realWorker);
      await realCustomer.agent.post(`${t.api}/bookings/${realBooking}/chat/messages`).send({ body: "real message", clientMessageId: "real-msg-0001" });
      await realCustomer.agent.post(`${t.api}/support/tickets`).send({ category: "GENERAL", subject: "Real question", body: "A real question about the service." });
      await realCustomer.agent.post(`${t.api}/community/posts`).send({ title: "Real post", body: "A real post body." });
      const admin = await t.newAdmin();
      await admin.agent.put(`${t.api}/admin/settings/platform.registrationsOpen`).send({ value: false, reason: "reset test" });
      const before = async () => ({
        bookings: await t.prisma.booking.count(), chat: await t.prisma.chatMessage.count(), payments: await t.prisma.payment.count(), events: await t.prisma.paymentEvent.count(),
        tickets: await t.prisma.supportTicket.count(), posts: await t.prisma.communityPost.count(), reviews: await t.prisma.review.count(), audit: await t.prisma.auditLog.count(),
        workers: await t.prisma.workerProfile.count(), notifications: await t.prisma.notification.count(), users: await t.prisma.user.count(),
      });
      const real = await before();
      expect(real.bookings).toBe(1);
      expect(real.chat).toBe(1);
      await both(); // open demo sessions

      const deleted = await resetDemoData(u());
      expect(deleted["bookings"]).toBe(11);
      expect(deleted["chat messages"]).toBeGreaterThan(5);
      expect(deleted["payment events"]).toBeGreaterThan(10);
      expect(await before()).toEqual(real); // every real count identical

      expect(await u().booking.count({ where: { customer: { isDemo: true } } })).toBe(0);
      expect(await u().payment.count({ where: { customer: { isDemo: true } } })).toBe(0);
      expect(await u().chatMessage.count({ where: { booking: { customer: { isDemo: true } } } })).toBe(0);
      expect(await u().session.count({ where: { user: { isDemo: true } } })).toBe(0);
      expect(await u().user.count({ where: { isDemo: true } })).toBe(11); // the identities stay
      // the guards are back: nobody can delete a chat message or a payment event any more
      await expect(u().chatMessage.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(u().paymentEvent.deleteMany({})).rejects.toThrow(/append-only/);

      const reseeded = await seedDemo(u(), { now: t.clock.now() });
      expect(reseeded.bookings).toBe(11);
      expect((await demoSession(t, "customer")).me.demo.role).toBe("customer");
    });
  });
});
