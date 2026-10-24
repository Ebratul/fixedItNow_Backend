import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { customer, type Person } from "./booking-helpers.js";
import { TEST_ENV } from "./fake-providers.js";
import { createTestApp, type TestApp } from "./helpers.js";
import { bkashCallback, events, latestBkashId, newKey, paymentStatus, payableBooking, sslCallback, startPayment, pastThrottle } from "./payment-helpers.js";

/** Refund workflow against the MOCKED provider (see test/fake-providers.ts). */
describe("refunds", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp(TEST_ENV);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.resetData();
  });

  const REASON = "I cancelled this booking and want my money back.";

  /** A verified payment (bKash by default) on a booking that is then cancelled. */
  async function paidAndCancelled(provider: "BKASH" | "SSLCOMMERZ" = "BKASH", cancel = true) {
    const ctx = await payableBooking(t);
    const res = await startPayment(t, ctx.cust, ctx.bookingId, provider);
    const ref = res.body.payment.reference as string;
    if (provider === "BKASH") {
      const id = latestBkashId(t);
      t.net.bkashApprove(id);
      await bkashCallback(t, ref, id);
    } else {
      const txn = t.net.sslPay(ref);
      await sslCallback(t, "success", { tran_id: ref, val_id: txn.valId, status: "VALID" });
    }
    expect((await paymentStatus(t, ctx.cust, ref)).body.payment.status).toBe("SUCCEEDED");
    if (cancel) {
      const c = await ctx.cust.agent.post(`${t.api}/bookings/${ctx.bookingId}/cancel`).send({ reason: "Plans changed completely" });
      expect(c.status).toBe(200);
    }
    return { ...ctx, ref };
  }

  const request = (c: Person, ref: string, body: object = { reason: REASON }, key: string | null = newKey()) => {
    const r = c.agent.post(`${t.api}/payments/${ref}/refunds`);
    if (key) r.set("Idempotency-Key", key);
    return r.send(body);
  };
  const admin = async () => t.newAdmin();
  const act = (a: Person, id: string, action: string, body: object = {}) => a.agent.post(`${t.api}/admin/refunds/${id}/${action}`).send(body);
  const payment = (ref: string) => t.prisma.payment.findUniqueOrThrow({ where: { reference: ref } });

  describe("requests", () => {
    it("lets the customer request a refund for their cancelled, verified payment — without refunding anything", async () => {
      const { cust, ref } = await paidAndCancelled();
      const res = await request(cust, ref);
      expect(res.status).toBe(201);
      expect(res.body.refund).toMatchObject({ status: "REQUESTED", requestedAmountBdt: 500, approvedAmountBdt: null });
      const p = await payment(ref);
      expect(p).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 }); // a request is not a refund
      expect(t.net.callsTo("/refund/")).toHaveLength(0);
      const detail = await paymentStatus(t, cust, ref);
      expect(detail.body.payment.refunds).toHaveLength(1);
      expect(detail.body.payment.refundableAmountBdt).toBe(500);
    });

    it("refuses when the booking is not cancelled, the payment is not verified, or it is someone else's", async () => {
      const live = await paidAndCancelled("BKASH", false);
      const r = await request(live.cust, live.ref);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("REFUND_NOT_ELIGIBLE");

      const unpaid = await payableBooking(t, { hour: 15 });
      const started = await startPayment(t, unpaid.cust, unpaid.bookingId, "BKASH");
      await unpaid.cust.agent.post(`${t.api}/bookings/${unpaid.bookingId}/cancel`).send({ reason: "Plans changed completely" });
      const u = await request(unpaid.cust, started.body.payment.reference);
      expect(u.body.code).toBe("PAYMENT_NOT_REFUNDABLE");

      const { ref } = await paidAndCancelled("SSLCOMMERZ");
      const stranger = await customer(t);
      expect((await request(stranger, ref)).status).toBe(404);
      expect((await t.client().post(`${t.api}/payments/${ref}/refunds`).send({ reason: REASON })).status).toBe(401);
    });

    it("never accepts a client-chosen status, provider reference or an amount over what remains", async () => {
      const { cust, ref } = await paidAndCancelled();
      for (const extra of [{ status: "SUCCEEDED" }, { approvedAmountBdt: 500 }, { providerRefundId: "x" }]) {
        expect((await request(cust, ref, { reason: REASON, ...extra })).status).toBe(400);
      }
      const over = await request(cust, ref, { reason: REASON, amountBdt: 501 });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe("REFUND_EXCEEDS_REMAINING");
      expect((await request(cust, ref, { reason: "short" })).status).toBe(400);
      expect(await t.prisma.refund.count()).toBe(0);
    });

    it("handles duplicate and parallel requests safely", async () => {
      const { cust, ref } = await paidAndCancelled();
      const key = newKey();
      const a = await request(cust, ref, { reason: REASON }, key);
      const b = await request(cust, ref, { reason: REASON }, key);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body.refund.id).toBe(a.body.refund.id);
      expect((await request(cust, ref)).body.code).toBe("REFUND_IN_PROGRESS");
      expect(await t.prisma.refund.count()).toBe(1);

      const fresh = await paidAndCancelled("SSLCOMMERZ");
      const results = await Promise.all(Array.from({ length: 6 }, () => request(fresh.cust, fresh.ref)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "REFUND_IN_PROGRESS")).toBe(true);
    });
  });

  describe("admin decisions", () => {
    it("restricts review to administrators who are not part of the booking", async () => {
      const { cust, worker, ref } = await paidAndCancelled();
      const refund = (await request(cust, ref)).body.refund;
      for (const who of [cust, worker]) {
        for (const action of ["approve", "reject", "process", "reconcile"]) {
          expect((await act(who, refund.id, action, action === "reject" ? { note: "no" } : {})).status, action).toBe(403);
        }
      }
      expect((await t.client().post(`${t.api}/admin/refunds/${refund.id}/approve`).send({})).status).toBe(401);
      expect((await cust.agent.get(`${t.api}/admin/refunds`)).status).toBe(403);
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("REQUESTED");
    });

    it("approval is a decision, not money: nothing is refunded and no provider call is made", async () => {
      const { cust, ref } = await paidAndCancelled();
      const refund = (await request(cust, ref)).body.refund;
      const a = await admin();
      const res = await act(a, refund.id, "approve", { note: "Cancelled by customer" });
      expect(res.body.refund).toMatchObject({ status: "APPROVED", approvedAmountBdt: 500 });
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });
      expect(t.net.callsTo("/refund/")).toHaveLength(0);
      expect((await act(a, refund.id, "approve")).body.code).toBe("INVALID_REFUND_TRANSITION"); // not twice
      expect(await t.prisma.auditLog.count({ where: { action: "refund.approve", actorId: a.userId } })).toBe(1);
    });

    it("can approve a smaller amount but never a larger one", async () => {
      const { cust, ref } = await paidAndCancelled();
      const refund = (await request(cust, ref)).body.refund;
      const a = await admin();
      expect((await act(a, refund.id, "approve", { amountBdt: 600 })).body.code).toBe("REFUND_EXCEEDS_REMAINING");
      expect((await act(a, refund.id, "approve", { amountBdt: 200 })).body.refund.approvedAmountBdt).toBe(200);
    });

    it("rejecting records the decision and frees the payment for a new request", async () => {
      const { cust, ref } = await paidAndCancelled();
      const refund = (await request(cust, ref)).body.refund;
      const a = await admin();
      const res = await act(a, refund.id, "reject", { note: "Outside our policy" });
      expect(res.body.refund).toMatchObject({ status: "REJECTED", decisionNote: "Outside our policy" });
      expect((await act(a, refund.id, "process")).body.code).toBe("INVALID_REFUND_TRANSITION");
      expect((await request(cust, ref)).status).toBe(201);
      expect((await paymentStatus(t, cust, ref)).body.payment.status).toBe("SUCCEEDED");
    });

    it("an administrator cannot act on their own booking's refund", async () => {
      const a = await admin();
      const ctx = await payableBooking(t, { cust: a });
      const res = await startPayment(t, a, ctx.bookingId, "BKASH");
      const ref = res.body.payment.reference as string;
      const id = latestBkashId(t);
      t.net.bkashApprove(id);
      await bkashCallback(t, ref, id);
      await a.agent.post(`${t.api}/bookings/${ctx.bookingId}/cancel`).send({ reason: "Plans changed completely" });
      const refund = (await request(a, ref)).body.refund;
      expect((await act(a, refund.id, "approve")).status).toBe(404);
    });
  });

  describe("provider processing", () => {
    async function approved(provider: "BKASH" | "SSLCOMMERZ" = "BKASH", amountBdt?: number) {
      const ctx = await paidAndCancelled(provider);
      const refund = (await request(ctx.cust, ctx.ref, amountBdt ? { reason: REASON, amountBdt } : { reason: REASON })).body.refund;
      const a = await admin();
      await act(a, refund.id, "approve");
      return { ...ctx, refund, a };
    }

    it("refunds through bKash only after the provider confirms it", async () => {
      const { cust, ref, refund, a } = await approved();
      const res = await act(a, refund.id, "process");
      expect(res.status).toBe(200);
      expect(res.body.refund.status).toBe("SUCCEEDED");
      expect(t.net.callsTo("/refund/payment/transaction")).toHaveLength(1);
      expect(t.net.callsTo("/refund/payment/status").length).toBeGreaterThanOrEqual(1); // independent confirmation
      expect(t.net.callsTo("/refund/payment/transaction")[0]!.json).toMatchObject({ refundAmount: "500.00", sku: "service-booking" });
      expect(await payment(ref)).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500 });
      const seen = await paymentStatus(t, cust, ref);
      expect(seen.body.payment).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500, refundableAmountBdt: 0 });
      expect(await t.prisma.paymentEvent.count({ where: { type: "refund.succeeded" } })).toBe(1);
      expect((await act(a, refund.id, "process")).body.code).toBe("INVALID_REFUND_TRANSITION"); // no second provider refund
      expect(t.net.callsTo("/refund/payment/transaction")).toHaveLength(1);
    });

    it("refunds through SSLCOMMERZ using the bank transaction id, confirmed by the refund-status API", async () => {
      const { ref, refund, a } = await approved("SSLCOMMERZ");
      const res = await act(a, refund.id, "process");
      expect(res.body.refund.status).toBe("SUCCEEDED");
      const call = t.net.callsTo("merchantTransIDvalidationAPI").find((c) => c.query.bank_tran_id)!;
      expect(call.query).toMatchObject({ refund_amount: "500.00", refund_remarks: expect.any(String) });
      expect(call.query.refund_trans_id).toMatch(/^RFD[0-9A-F]{24}$/);
      expect(await payment(ref)).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500 });
    });

    it("keeps a provider-accepted refund PROCESSING until the provider confirms completion", async () => {
      const { ref, refund, a } = await approved();
      t.net.bkashRefundsComplete = false;
      const res = await act(a, refund.id, "process");
      expect(res.body.refund.status).toBe("PROCESSING");
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 }); // accepted != refunded
      expect((await act(a, refund.id, "reconcile")).body.refund.status).toBe("PROCESSING");
      t.net.completeBkashRefund((await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).providerRefundId!);
      expect((await act(a, refund.id, "reconcile")).body.refund.status).toBe("SUCCEEDED");
      await act(a, refund.id, "reconcile"); // idempotent
      expect(await payment(ref)).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500 });
      expect(await t.prisma.paymentEvent.count({ where: { type: "refund.succeeded" } })).toBe(1);
    });

    it("does not mark SSLCOMMERZ refunds successful while processing, and fails them when cancelled", async () => {
      const { ref, refund, a } = await approved("SSLCOMMERZ");
      t.net.sslRefundsComplete = false;
      expect((await act(a, refund.id, "process")).body.refund.status).toBe("PROCESSING");
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });
      const row = await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      t.net.sslRefunds.get(row.providerRefundId!)!.status = "cancelled";
      expect((await act(a, refund.id, "reconcile")).body.refund.status).toBe("FAILED");
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });
    });

    it("does not resend an unanswered refund (a retry could refund twice) and does not call it failed", async () => {
      const { ref, refund, a } = await approved();
      t.net.fail("/refund/payment/transaction", "timeout");
      const res = await act(a, refund.id, "process");
      expect(res.body.refund.status).toBe("PROCESSING");
      expect((await act(a, refund.id, "process")).body.code).toBe("INVALID_REFUND_TRANSITION");
      expect(t.net.callsTo("/refund/payment/transaction")).toHaveLength(1);
      expect((await act(a, refund.id, "reconcile")).body.refund.status).toBe("PROCESSING"); // not listed at the provider: unknown stays unknown
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });
    });

    it("marks a refund the provider refused as failed, leaving the payment untouched", async () => {
      const { ref, refund, a } = await approved();
      await t.prisma.payment.update({ where: { reference: ref }, data: { providerTransactionId: "WRONG-TRX" } });
      const res = await act(a, refund.id, "process");
      expect(res.body.refund.status).toBe("FAILED");
      expect(await payment(ref)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });
    });

    it("lets exactly one of many parallel process requests reach the provider", async () => {
      const { refund, a } = await approved();
      const results = await Promise.all(Array.from({ length: 5 }, () => act(a, refund.id, "process")));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(t.net.callsTo("/refund/payment/transaction")).toHaveLength(1);
    });

    it("supports partial refunds and never exceeds the remaining amount", async () => {
      const { cust, ref, refund, a } = await approved("BKASH", 200);
      await act(a, refund.id, "process");
      expect(await payment(ref)).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedAmountBdt: 200 });
      expect((await paymentStatus(t, cust, ref)).body.payment.refundableAmountBdt).toBe(300);
      expect((await request(cust, ref, { reason: REASON, amountBdt: 301 })).body.code).toBe("REFUND_EXCEEDS_REMAINING");
      const rest = (await request(cust, ref, { reason: REASON })).body.refund;
      expect(rest.requestedAmountBdt).toBe(300);
      await act(a, rest.id, "approve");
      await act(a, rest.id, "process");
      expect(await payment(ref)).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500 });
      expect((await request(cust, ref)).body.code).toBe("PAYMENT_NOT_REFUNDABLE");
    });

    it("reports honestly when the provider's refund API is not enabled for this merchant", async () => {
      const off = await createTestApp({ ...TEST_ENV, BKASH_REFUNDS_ENABLED: "false" });
      try {
        await off.resetData();
        const ctx = await payableBooking(off);
        const res = await startPayment(off, ctx.cust, ctx.bookingId, "BKASH");
        const ref = res.body.payment.reference as string;
        const id = latestBkashId(off);
        off.net.bkashApprove(id);
        await bkashCallback(off, ref, id);
        await ctx.cust.agent.post(`${off.api}/bookings/${ctx.bookingId}/cancel`).send({ reason: "Plans changed completely" });
        const refund = (await ctx.cust.agent.post(`${off.api}/payments/${ref}/refunds`).send({ reason: REASON })).body.refund;
        const a = await off.newAdmin();
        await a.agent.post(`${off.api}/admin/refunds/${refund.id}/approve`).send({});
        const out = await a.agent.post(`${off.api}/admin/refunds/${refund.id}/process`).send({});
        expect(out.status).toBe(422);
        expect(out.body.code).toBe("REFUNDS_NOT_SUPPORTED");
        expect(off.net.callsTo("/refund/")).toHaveLength(0);
        expect((await off.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("APPROVED"); // stays approved, never "done"
        expect((await off.prisma.payment.findUniqueOrThrow({ where: { reference: ref } })).status).toBe("SUCCEEDED");
      } finally {
        await off.close();
      }
    });

    it("keeps refunds out of the way of the admin queue's secrets", async () => {
      const { refund, a } = await approved();
      const list = await a.agent.get(`${t.api}/admin/refunds?status=APPROVED`);
      expect(list.body.refunds).toHaveLength(1);
      const text = JSON.stringify(list.body) + JSON.stringify((await a.agent.get(`${t.api}/admin/refunds/${refund.id}`)).body);
      expect(text).not.toMatch(/DO-NOT-LEAK|requestedByUserId|providerTransactionId|@example\.com/);
    });
  });

  describe("administrator-initiated refunds", () => {
    it("can refund a verified duplicate payment, but not an unexplained review item", async () => {
      const ctx = await payableBooking(t);
      const first = await startPayment(t, ctx.cust, ctx.bookingId, "SSLCOMMERZ");
      const firstRef = first.body.payment.reference as string;
      t.clock.advanceMinutes(31);
      await paymentStatus(t, ctx.cust, firstRef); // expires
      const second = await startPayment(t, ctx.cust, ctx.bookingId, "SSLCOMMERZ");
      const secondRef = second.body.payment.reference as string;
      await sslCallback(t, "success", { tran_id: secondRef, val_id: t.net.sslPay(secondRef).valId, status: "VALID" });
      await sslCallback(t, "success", { tran_id: firstRef, val_id: t.net.sslPay(firstRef).valId, status: "VALID" });
      expect((await payment(firstRef)).reviewReason).toBe("DUPLICATE_PAYMENT");

      const a = await admin();
      const created = await a.agent.post(`${t.api}/admin/payments/${firstRef}/refunds`).set("Idempotency-Key", newKey()).send({ reason: "Duplicate payment for the same booking" });
      expect(created.status).toBe(201);
      expect(created.body.refund).toMatchObject({ status: "APPROVED", approvedAmountBdt: 500 });
      const done = await act(a, created.body.refund.id, "process");
      expect(done.body.refund.status).toBe("SUCCEEDED");
      expect(await payment(firstRef)).toMatchObject({ status: "REFUNDED", refundedAmountBdt: 500 });
      expect(await payment(secondRef)).toMatchObject({ status: "SUCCEEDED", refundedAmountBdt: 0 });

      // An amount-mismatch review item is NOT refundable through this API.
      const other = await payableBooking(t, { hour: 15 });
      const m = await startPayment(t, other.cust, other.bookingId, "SSLCOMMERZ");
      const mRef = m.body.payment.reference as string;
      await sslCallback(t, "success", { tran_id: mRef, val_id: t.net.sslPay(mRef, { amount: "10.00" }).valId, status: "VALID" });
      const bad = await a.agent.post(`${t.api}/admin/payments/${mRef}/refunds`).send({ reason: "Trying to refund a mismatch" });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("PAYMENT_NOT_REFUNDABLE");
      expect(await events(t, firstRef, "refund.requested")).toHaveLength(1);
      pastThrottle(t);
    });
  });
});
