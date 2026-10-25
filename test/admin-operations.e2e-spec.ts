import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookableWorker, customer } from "./booking-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";
import { SECRET_MARKERS, TEST_ENV } from "./fake-providers.js";
import { bkashCallback, cancelViaDispute, latestBkashId, payableBooking, startPayment } from "./payment-helpers.js";

const REPORT = "from=2026-10-30T00:00:00Z&to=2026-11-04T00:00:00Z";

describe("admin operations: bookings, payments, finance, dashboard, ops", () => {
  let t: TestApp;
  // Provider credentials are the fake ones; real refunds stay switched off, so nothing here could move money even in principle.
  beforeAll(async () => { t = await createTestApp({ ...TEST_ENV, BKASH_REFUNDS_ENABLED: "false" }); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  /** The work is finished (the clock moved to the appointment), then the clock returns to the suite's day so reports line up. */
  const DAY = "2026-11-01T06:00:00Z";
  async function finished(opts: Parameters<typeof payableBooking>[1] = {}) {
    const ctx = await payableBooking(t, opts);
    t.clock.set(DAY);
    return ctx;
  }

  async function paid() {
    const ctx = await finished();
    const res = await startPayment(t, ctx.cust, ctx.bookingId, "BKASH");
    const ref = res.body.payment.reference as string;
    const id = latestBkashId(t);
    t.net.bkashApprove(id);
    await bkashCallback(t, ref, id);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { reference: ref } })).status).toBe("SUCCEEDED");
    return { ...ctx, ref };
  }

  describe("booking monitor", () => {
    it("lists and filters bookings with status counts, and keeps addresses out of the list", async () => {
      const admin = await t.newAdminWith(["bookings.read"]);
      const w = await bookableWorker(t);
      const c1 = await customer(t, "Alice Customer");
      await customer(t, "Bob Customer");
      const { bookingId } = await finished({ worker: w, cust: c1 });
      const all = await admin.agent.get(`${t.api}/admin/bookings`);
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(1);
      expect(all.body.bookings[0]).toMatchObject({ id: bookingId, status: "COMPLETION_PENDING", customer: { name: "Alice Customer" }, worker: { displayName: expect.any(String) } });
      expect(all.body.statusCounts).toEqual({ COMPLETION_PENDING: 1 });
      expect(JSON.stringify(all.body)).not.toMatch(/Dhanmondi|ceiling fan|@example\.com/); // no address, free text or e-mail in the list
      expect((await admin.agent.get(`${t.api}/admin/bookings?status=COMPLETED`)).body.total).toBe(0);
      expect((await admin.agent.get(`${t.api}/admin/bookings?q=alice`)).body.total).toBe(1);
      expect((await admin.agent.get(`${t.api}/admin/bookings?q=${bookingId}`)).body.total).toBe(1);
      expect((await admin.agent.get(`${t.api}/admin/bookings?q=nobody`)).body.total).toBe(0);
      for (const q of ["status=NOPE", "pageSize=999", "categoryId=x", "from=never"]) expect((await admin.agent.get(`${t.api}/admin/bookings?${q}`)).status, q).toBe(400);
    });

    it("shows the full timeline of one booking, but still no e-mail addresses", async () => {
      const admin = await t.newAdmin();
      const { bookingId } = await finished();
      const res = await admin.agent.get(`${t.api}/admin/bookings/${bookingId}`);
      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ id: bookingId, status: "COMPLETION_PENDING", serviceAddress: expect.stringContaining("Dhanmondi") });
      expect(res.body.booking.events.length).toBeGreaterThan(1);
      expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
      expect((await admin.agent.get(`${t.api}/admin/bookings/0192a000-0000-7000-8000-000000000000`)).status).toBe(404);
      expect((await admin.agent.get(`${t.api}/admin/bookings/nope`)).status).toBe(400);
    });

    it("needs bookings.read", async () => {
      const finance = await t.newAdminWith(["payments.read"]);
      expect((await finance.agent.get(`${t.api}/admin/bookings`)).status).toBe(403);
    });
  });

  describe("payment monitor", () => {
    it("filters by status, provider, reference, booking and date; shows the customer's name only", async () => {
      const admin = await t.newAdmin();
      const p = await paid();
      const list = await admin.agent.get(`${t.api}/admin/payments`);
      expect(list.body.total).toBe(1);
      expect(list.body.payments[0]).toMatchObject({ reference: p.ref, status: "SUCCEEDED", provider: "BKASH", customer: { name: "Customer" } });
      expect(JSON.stringify(list.body)).not.toMatch(/@example\.com|checkout|paymentID|token/i);
      const get = (q: string) => admin.agent.get(`${t.api}/admin/payments?${q}`).then((r) => r.body.total as number);
      expect(await get("status=SUCCEEDED")).toBe(1);
      expect(await get("status=FAILED")).toBe(0);
      expect(await get("provider=BKASH")).toBe(1);
      expect(await get(`q=${p.ref.slice(0, 8)}`)).toBe(1);
      expect(await get(`q=${p.bookingId}`)).toBe(1);
      expect(await get("q=zzzzzz")).toBe(0);
      expect(await get("from=2026-12-01")).toBe(0);
      expect(await get(REPORT)).toBe(1);
      for (const q of ["provider=PAYPAL", "provider=SSLCOMMERZ", "q=ab", "status=nope", "from=x"]) expect((await admin.agent.get(`${t.api}/admin/payments?${q}`)).status, q).toBe(400);
    });

    it("never accepts a payment status from the client", async () => {
      const admin = await t.newAdmin();
      const p = await paid();
      for (const [method, path] of [["post", `payments/${p.ref}`], ["put", `payments/${p.ref}`], ["patch", `payments/${p.ref}`], ["post", `payments/${p.ref}/status`], ["post", `payments/${p.ref}/mark-paid`]] as const) {
        const res = await (admin.agent as never as Record<string, (u: string) => { send: (b: object) => Promise<{ status: number }> }>)[method](`${t.api}/admin/${path}`).send({ status: "SUCCEEDED" });
        expect([404, 405], `${method} ${path}`).toContain(res.status);
      }
    });
  });

  describe("refunds: permissions and explicit confirmation", () => {
    it("separates deciding from processing, and demands confirm:true on money-moving calls", async () => {
      const p = await paid();
      await cancelViaDispute(t, p.cust, p.bookingId);
      const refund = (await p.cust.agent.post(`${t.api}/payments/${p.ref}/refunds`).set("Idempotency-Key", "refund-key-000001").send({ reason: "I cancelled this booking and want my money back." })).body.refund;

      const reader = await t.newAdminWith(["payments.read"]);
      const decider = await t.newAdminWith(["payments.read", "refunds.decide"]);
      const processor = await t.newAdminWith(["payments.read", "refunds.process"]);
      const post = (a: typeof reader, action: string, body: object) => a.agent.post(`${t.api}/admin/refunds/${refund.id}/${action}`).send(body);

      expect((await reader.agent.get(`${t.api}/admin/refunds`)).status).toBe(200);
      expect((await post(reader, "approve", { confirm: true })).status).toBe(403);
      expect((await post(processor, "approve", { confirm: true })).status).toBe(403);
      expect((await post(decider, "approve", {})).status).toBe(400); // no confirmation
      expect((await post(decider, "approve", { confirm: false })).status).toBe(400);
      expect((await post(decider, "approve", { confirm: true, amountBdt: 100000 })).status).toBe(422);
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("REQUESTED");
      expect((await post(decider, "approve", { confirm: true })).status).toBe(200);

      expect((await post(decider, "process", { confirm: true })).status).toBe(403); // deciding is not processing
      expect((await post(processor, "process", {})).status).toBe(400);
      const refused = await post(processor, "process", { confirm: true });
      expect(refused.status).toBe(422); // provider refunds are switched off in this environment: nothing is sent
      expect(refused.body.code).toBe("REFUNDS_NOT_SUPPORTED");
      expect(t.net.callsTo("/refund")).toHaveLength(0);
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("APPROVED");

      const trail = await t.prisma.auditLog.findMany({ where: { targetType: "Refund", targetId: refund.id }, orderBy: { seq: "asc" } });
      expect(trail.map((r) => r.action)).toEqual(["refund.approve"]);
      expect(trail[0]).toMatchObject({ actorId: decider.userId });
    });

    it("an admin-created refund also needs permission and confirmation", async () => {
      const p = await paid();
      const decider = await t.newAdminWith(["refunds.decide", "payments.read"]);
      const reader = await t.newAdminWith(["payments.read"]);
      const body = { reason: "Duplicate payment for the same booking" };
      const url = `${t.api}/admin/payments/${p.ref}/refunds`;
      expect((await reader.agent.post(url).set("Idempotency-Key", "adm-refund-000001").send({ ...body, confirm: true })).status).toBe(403);
      expect((await decider.agent.post(url).set("Idempotency-Key", "adm-refund-000002").send(body)).status).toBe(400);
      expect(await t.prisma.refund.count()).toBe(0);
      expect((await decider.agent.post(url).set("Idempotency-Key", "adm-refund-000003").send({ ...body, confirm: true })).status).toBe(201);
    });
  });

  describe("finance reports", () => {
    it("computes collected, refunded, net and commission from verified rows only", async () => {
      const admin = await t.newAdmin();
      const a = await paid();
      await paid();
      // a pending attempt and a failed one must not count
      const c = await customer(t);
      const other = await finished({ cust: c, days: 5 });
      await startPayment(t, other.cust, other.bookingId, "BKASH");
      // one fully refunded payment: provider-confirmed refund row
      const pay = await t.prisma.payment.findUniqueOrThrow({ where: { reference: a.ref } });
      await t.prisma.refund.create({
        data: { paymentId: pay.id, requestedByUserId: a.cust.userId, requestedByRole: "CUSTOMER", requestedAmountBdt: 500, approvedAmountBdt: 500, reason: "test refund row", status: "SUCCEEDED", providerRefundReference: "RFDTEST0000001", completedAt: new Date("2026-11-02T06:00:00Z") },
      });
      await t.prisma.payment.update({ where: { id: pay.id }, data: { status: "REFUNDED", refundedAmountBdt: 500 } });

      const sum = await admin.agent.get(`${t.api}/admin/finance/summary?${REPORT}`);
      expect(sum.status).toBe(200);
      expect(sum.body.totals).toEqual({ collectedBdt: 1000, refundedBdt: 500, netBdt: 500, successfulPayments: 2 });
      expect(sum.body.byProvider).toEqual([{ provider: "BKASH", collectedBdt: 1000, payments: 2 }]);
      expect(sum.body.byStatus.INITIATED).toBeGreaterThanOrEqual(1);
      expect(sum.body.daily).toHaveLength(5);
      expect(sum.body.daily.find((d: { day: string }) => d.day === "2026-11-01")).toMatchObject({ collected: 1000, refunded: 0 });
      expect(sum.body.daily.find((d: { day: string }) => d.day === "2026-11-02")).toMatchObject({ collected: 0, refunded: 500 });

      // commission: reporting only, rate from the platform setting or an explicit what-if override
      const zero = await admin.agent.get(`${t.api}/admin/finance/commission?${REPORT}`);
      expect(zero.body).toMatchObject({ rateBps: 0, rateSource: "setting", reportingOnly: true, totals: { netBdt: 500, commissionBdt: 0 } });
      await admin.agent.put(`${t.api}/admin/settings/finance.commissionBps`).send({ value: 1000, reason: "Pilot rate" });
      const ten = await admin.agent.get(`${t.api}/admin/finance/commission?${REPORT}`);
      expect(ten.body).toMatchObject({ rateBps: 1000, totals: { collectedBdt: 1000, refundedBdt: 500, netBdt: 500, commissionBdt: 50 } });
      expect(ten.body.note).toMatch(/no fee is charged/i);
      const whatIf = await admin.agent.get(`${t.api}/admin/finance/commission?${REPORT}&rateBps=250`);
      expect(whatIf.body).toMatchObject({ rateBps: 250, rateSource: "override", configuredRateBps: 1000, totals: { commissionBdt: 13 } });

      const csv = await admin.agent.get(`${t.api}/admin/finance/commission/export?${REPORT}`);
      expect(csv.status).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.text.split("\n")[0]).toBe("day,collected_bdt,refunded_bdt,net_bdt,commission_bdt_at_1000_bps");
      expect(csv.text).toContain("2026-11-01,1000,0,1000,100");
      expect(await t.prisma.auditLog.count({ where: { action: "finance.export" } })).toBe(1);
    });

    it("validates ranges and rates, and needs finance.reports", async () => {
      const admin = await t.newAdmin();
      for (const q of ["from=2026-11-04&to=2026-11-01", "from=2020-01-01&to=2026-11-01", "rateBps=9000", "rateBps=-1", "from=nonsense"]) {
        expect((await admin.agent.get(`${t.api}/admin/finance/commission?${q}`)).status, q).toBe(400);
      }
      const payer = await t.newAdminWith(["payments.read", "payments.reconcile", "refunds.decide"]);
      for (const path of ["summary", "commission", "commission/export"]) expect((await payer.agent.get(`${t.api}/admin/finance/${path}`)).status, path).toBe(403);
    });
  });

  describe("dashboard", () => {
    it("reports real counts and zero-filled daily trends", async () => {
      const admin = await t.newAdmin();
      await t.createWorker({ stage: "submitted", admin });
      await t.createWorker({ stage: "published", admin });
      await paid();
      const res = await admin.agent.get(`${t.api}/admin/dashboard?days=7`);
      expect(res.status).toBe(200);
      const d = res.body;
      expect(d.users.total).toBe(await t.prisma.user.count());
      expect(d.workers).toMatchObject({ total: 3, pending: 1, verified: 2, published: 2 }); // submitted + published + the bookable worker from paid()
      expect(d.bookings.byStatus.COMPLETED).toBe(1); // paid() ends with a verified payment, which completes the booking
      expect(d.trends.newUsers).toHaveLength(7);
      expect(d.trends.newUsers.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBe(d.users.total);
      expect(d.finance).toMatchObject({ collectedBdt: 500, payments: 1 });
      const attention = Object.fromEntries(d.attention.map((a: { key: string; count: number }) => [a.key, a.count]));
      expect(attention).toMatchObject({ workerReviews: 1, disputes: 0, tickets: 0 });
      expect(Array.isArray(d.recentActivity)).toBe(true);
      expect(JSON.stringify(d)).not.toMatch(/@example\.com|password|Dhanmondi/);
    });

    it("shows only what the caller may open", async () => {
      const w = await t.newAdminWith(["dashboard.view", "workers.read"]);
      await t.createWorker({ stage: "submitted" });
      const d = (await w.agent.get(`${t.api}/admin/dashboard`)).body;
      expect(d.attention.map((a: { key: string }) => a.key)).toEqual(["workerReviews"]);
      expect(d.finance).toBeNull();
      expect(d.recentActivity).toBeNull();
      const none = await t.newAdminWith(["users.read"]);
      expect((await none.agent.get(`${t.api}/admin/dashboard`)).status).toBe(403);
    });

    it("validates the window", async () => {
      const admin = await t.newAdmin();
      for (const q of ["days=0", "days=45", "days=abc", "days=3650"]) expect((await admin.agent.get(`${t.api}/admin/dashboard?${q}`)).status, q).toBe(400);
    });
  });

  describe("operations status", () => {
    it("reports integrations honestly (probed vs only configured) and leaks no secrets", async () => {
      const admin = await t.newAdmin();
      const res = await admin.agent.get(`${t.api}/admin/ops/status`);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.integrations.map((i: { id: string }) => [i.id, i]));
      expect(byId.database).toMatchObject({ status: "ok", probed: true });
      expect(byId.migrations).toMatchObject({ status: "ok", probed: true });
      expect(byId.bkash).toMatchObject({ status: "sandbox", probed: false });
      expect(byId.bkash.detail).toMatch(/Refunds disabled/);
      expect(res.body.payments.refundsEnabled).toEqual({ bkash: false });
      expect(byId.ai).toMatchObject({ status: "not_configured" });
      expect(byId.documents).toMatchObject({ status: "ok", probed: false });
      expect(byId.mail.status).toBe("off");
      expect(res.body.databaseLatencyMs).toBeGreaterThanOrEqual(0);
      expect(res.body.queues).toMatchObject({ ticketsOpen: 0, disputesOpen: 0 });
      const text = JSON.stringify(res.body);
      for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
      expect(text).not.toContain("test-secret-test-secret");
      expect(text).not.toContain(Buffer.alloc(32, 7).toString("base64"));
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
    });

    it("needs ops.read", async () => {
      const u = await t.newAdminWith(["users.read"]);
      expect((await u.agent.get(`${t.api}/admin/ops/status`)).status).toBe(403);
    });
  });
});
