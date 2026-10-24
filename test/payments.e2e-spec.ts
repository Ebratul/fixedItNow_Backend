import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { at, bookableWorker, customer, requestBooking } from "./booking-helpers.js";
import { SECRET_MARKERS, TEST_ENV } from "./fake-providers.js";
import { createTestApp, WEB_ORIGIN, type TestApp } from "./helpers.js";
import {
  bkashCallback,
  events,
  latestBkashId,
  newKey,
  paymentStatus,
  pastThrottle,
  payableBooking,
  raw,
  sslCallback,
  sslIpn,
  startPayment,
} from "./payment-helpers.js";

/**
 * Payment initiation, verification, callbacks and consistency.
 * Provider HTTP is a MOCK (test/fake-providers.ts): these tests prove OUR logic,
 * not that bKash or SSLCOMMERZ behave like the mock (see docs/PAYMENTS.md).
 */
describe("payments", () => {
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

  const statusOf = async (cust: Awaited<ReturnType<typeof customer>>, ref: string) => (await paymentStatus(t, cust, ref)).body.payment.status as string;
  const count = (type: string, ref: string) => events(t, ref, type).then((e) => e.length);

  // ---------------------------------------------------------------- initiation
  describe("initiation", () => {
    it("requires authentication", async () => {
      const { bookingId } = await payableBooking(t);
      const res = await t.client().post(`${t.api}/bookings/${bookingId}/payments`).send({ provider: "BKASH" });
      expect(res.status).toBe(401);
      expect((await t.client().get(`${t.api}/payments`)).status).toBe(401);
      expect((await t.client().get(`${t.api}/payments/providers`)).status).toBe(401);
    });

    it("lets the customer pay their own confirmed booking, with a server-derived amount", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "BKASH");
      expect(res.status).toBe(201);
      expect(res.body.payment).toMatchObject({ provider: "BKASH", status: "INITIATED", amountBdt: 500, currency: "BDT", bookingId, mode: "sandbox" });
      expect(res.body.checkoutUrl).toMatch(/^https:\/\/sandbox\.bka\.sh\/checkout\/TR/);
      // The amount sent to the provider is the stored 500, formatted from integer taka.
      expect(t.net.callsTo("/payment/create")[0]!.json).toMatchObject({ amount: "500.00", currency: "BDT", merchantInvoiceNumber: res.body.payment.reference });
    });

    it("charges the ACCEPTED QUOTE total for quote-priced work", async () => {
      const worker = await bookableWorker(t);
      const cust = await customer(t);
      const created = await requestBooking(t, cust, worker, at(t, 3, 10), { categorySlug: "ac-repair" });
      const id = created.body.booking.id as string;
      const quote = await worker.agent.post(`${t.api}/bookings/${id}/quotes`).send({ laborBdt: 800, materialsBdt: 300, otherBdt: 50, description: "Gas refill and filter cleaning." });
      const quoteId = quote.body.quotes[0].id as string;
      await cust.agent.post(`${t.api}/bookings/${id}/quotes/${quoteId}/accept`).send({});
      const res = await startPayment(t, cust, id, "SSLCOMMERZ");
      expect(res.status).toBe(201);
      expect(res.body.payment.amountBdt).toBe(1150);
      expect(t.net.callsTo("gwprocess")[0]!.form!.total_amount).toBe("1150.00");
    });

    it("ignores nothing: client-supplied amount, currency, status or ids are rejected", async () => {
      const { cust, bookingId } = await payableBooking(t);
      for (const extra of [{ amountBdt: 1 }, { amount: 1 }, { currency: "USD" }, { status: "SUCCEEDED" }, { customerId: "x" }, { providerTransactionId: "t" }, { refundedAmountBdt: 1 }]) {
        const res = await startPayment(t, cust, bookingId, "BKASH", newKey(), extra);
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
      expect((await startPayment(t, cust, bookingId, "PAYPAL" as never)).status).toBe(400);
      expect(await t.prisma.payment.count()).toBe(0);
      expect(t.net.calls.filter((c) => c.url.includes("/payment/create"))).toHaveLength(0);
    });

    it("is not available for another customer's booking, the professional, or an unknown booking (same 404)", async () => {
      const { cust, worker, bookingId } = await payableBooking(t);
      const stranger = await customer(t);
      for (const who of [stranger, worker]) {
        expect((await startPayment(t, who, bookingId, "BKASH")).status).toBe(404);
      }
      expect((await startPayment(t, cust, "00000000-0000-7000-8000-000000000000", "BKASH")).status).toBe(404);
      expect((await startPayment(t, cust, "not-a-uuid", "BKASH")).status).toBe(400);
      expect(await t.prisma.payment.count()).toBe(0);
    });

    it("only accepts payment while the booking is confirmed or later (never requested, cancelled or disputed)", async () => {
      const worker = await bookableWorker(t);
      const cust = await customer(t);
      const requested = await requestBooking(t, cust, worker, at(t, 3, 10));
      const r = await startPayment(t, cust, requested.body.booking.id, "BKASH");
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("BOOKING_NOT_PAYABLE");

      const { cust: c2, bookingId } = await payableBooking(t, { worker, hour: 14 });
      await c2.agent.post(`${t.api}/bookings/${bookingId}/cancel`).send({ reason: "Plans changed completely" });
      expect((await startPayment(t, c2, bookingId, "BKASH")).body.code).toBe("BOOKING_NOT_PAYABLE");

      const { cust: c3, bookingId: b3 } = await payableBooking(t, { worker, hour: 16 });
      await t.prisma.booking.update({ where: { id: b3 }, data: { status: "DISPUTED" } });
      expect((await startPayment(t, c3, b3, "BKASH")).body.code).toBe("BOOKING_NOT_PAYABLE");
    });

    it("refuses an amount outside the provider's limits and a booking without an agreed price", async () => {
      const { cust, bookingId } = await payableBooking(t);
      await t.prisma.booking.update({ where: { id: bookingId }, data: { agreedAmountBdt: 5 } });
      const low = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      expect(low.status).toBe(422);
      expect(low.body.code).toBe("AMOUNT_OUT_OF_RANGE");
      await t.prisma.booking.update({ where: { id: bookingId }, data: { agreedAmountBdt: null } });
      expect((await startPayment(t, cust, bookingId, "BKASH")).body.code).toBe("NO_AGREED_AMOUNT");
      await t.prisma.booking.update({ where: { id: bookingId }, data: { agreedAmountBdt: 500, currency: "USD" } });
      expect((await startPayment(t, cust, bookingId, "BKASH")).body.code).toBe("UNSUPPORTED_CURRENCY");
      expect(t.net.calls).toHaveLength(0);
    });

    it("replays an idempotent request without a second provider session", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const key = newKey();
      const a = await startPayment(t, cust, bookingId, "BKASH", key);
      const b = await startPayment(t, cust, bookingId, "BKASH", key);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.payment.reference).toBe(a.body.payment.reference);
      expect(b.body.checkoutUrl).toBe(a.body.checkoutUrl);
      expect(await t.prisma.payment.count()).toBe(1);
      expect(t.net.callsTo("/payment/create")).toHaveLength(1);
      // The same key for another provider is a client bug, not a replay.
      expect((await startPayment(t, cust, bookingId, "SSLCOMMERZ", key)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect((await startPayment(t, cust, bookingId, "BKASH", "short")).status).toBe(400);
    });

    it("lets exactly one of many parallel initiations create a chargeable session", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const results = await Promise.all(Array.from({ length: 6 }, () => startPayment(t, cust, bookingId, "BKASH")));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "PAYMENT_IN_PROGRESS")).toBe(true);
      expect(await t.prisma.payment.count()).toBe(1);
      expect(t.net.callsTo("/payment/create")).toHaveLength(1);
    });

    it("blocks a second attempt while one is open, allows it once that one is closed", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const first = await startPayment(t, cust, bookingId, "BKASH");
      expect((await startPayment(t, cust, bookingId, "SSLCOMMERZ")).body.code).toBe("PAYMENT_IN_PROGRESS");
      await bkashCallback(t, first.body.payment.reference, latestBkashId(t), "cancel");
      expect(await statusOf(cust, first.body.payment.reference)).toBe("CANCELLED");
      const second = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      expect(second.status).toBe(201);
      expect(await t.prisma.payment.count()).toBe(2); // history is kept
    });

    it("closes the attempt and reports a clean error when the provider cannot be reached", async () => {
      const { cust, bookingId } = await payableBooking(t);
      t.net.fail("/payment/create", "timeout");
      const res = await startPayment(t, cust, bookingId, "BKASH");
      expect(res.status).toBe(502);
      expect(res.body.code).toBe("PROVIDER_ERROR");
      expect(JSON.stringify(res.body)).not.toMatch(/timeout|stack|prisma/i);
      const row = await t.prisma.payment.findFirstOrThrow();
      expect(row.status).toBe("FAILED"); // no checkout URL was ever issued, so nothing can be charged
      expect(row.providerPaymentId).toBeNull();
      expect((await startPayment(t, cust, bookingId, "BKASH")).status).toBe(201);
    });

    it("never redirects to a checkout host the provider is not known to use", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const original = t.net.request.bind(t.net);
      t.net.request = async (req) => {
        const res = await original(req);
        if (req.url.endsWith("/payment/create")) (res.body as Record<string, unknown>).bKashURL = "https://evil.example.com/pay";
        return res;
      };
      try {
        const res = await startPayment(t, cust, bookingId, "BKASH");
        expect(res.status).toBe(502);
        expect(JSON.stringify(res.body)).not.toContain("evil.example.com");
      } finally {
        t.net.request = original;
      }
    });

    it("reports providers honestly and refuses an unconfigured one", async () => {
      const bare = await createTestApp(); // no provider credentials
      try {
        await bare.resetData();
        const worker = await bookableWorker(bare);
        const cust = await customer(bare);
        const booking = await requestBooking(bare, cust, worker, at(bare, 3, 10));
        await worker.agent.post(`${bare.api}/bookings/${booking.body.booking.id}/accept`).send({});
        const list = await cust.agent.get(`${bare.api}/payments/providers`);
        expect(list.body.providers).toEqual([
          expect.objectContaining({ provider: "BKASH", available: false, mode: null }),
          expect.objectContaining({ provider: "SSLCOMMERZ", available: false, mode: null }),
        ]);
        const res = await startPayment(bare, cust, booking.body.booking.id, "BKASH");
        expect(res.status).toBe(422);
        expect(res.body.code).toBe("PROVIDER_UNAVAILABLE");
        expect(bare.net.calls).toHaveLength(0);
      } finally {
        await bare.close();
      }
      const ok = await customer(t);
      const providers = await ok.agent.get(`${t.api}/payments/providers`);
      expect(providers.body.providers.map((p: any) => [p.provider, p.available, p.mode])).toEqual([["BKASH", true, "sandbox"], ["SSLCOMMERZ", true, "sandbox"]]);
    });
  });

  // ---------------------------------------------------------------- bKash
  describe("bKash verification", () => {
    async function started() {
      const ctx = await payableBooking(t);
      const res = await startPayment(t, ctx.cust, ctx.bookingId, "BKASH");
      return { ...ctx, ref: res.body.payment.reference as string, paymentId: latestBkashId(t) };
    }

    it("marks the payment SUCCEEDED only after execute + query confirm it, and leaves the booking lifecycle alone", async () => {
      const { cust, worker, bookingId, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId);
      const cb = await bkashCallback(t, ref, paymentId);
      expect(cb.status).toBe(303);
      expect(cb.headers.location).toBe(`${WEB_ORIGIN}/payments/${ref}?returned=1`);

      const res = await paymentStatus(t, cust, ref);
      expect(res.body.payment).toMatchObject({ status: "SUCCEEDED", amountBdt: 500, refundableAmountBdt: 500, needsAttention: false });
      expect(res.body.payment.providerTransactionId).toMatch(/^TRX/);
      expect(t.net.callsTo("/payment/execute")).toHaveLength(1);
      expect(t.net.callsTo("/query/payment").length).toBeGreaterThanOrEqual(1); // verified independently of execute

      const booking = await cust.agent.get(`${t.api}/bookings/${bookingId}`);
      expect(booking.body.booking.status).toBe("CONFIRMED"); // payment is not a lifecycle transition
      expect(booking.body.payment).toMatchObject({ state: "PAID", canPay: false });
      expect(booking.body.events.filter((e: any) => e.type === "payment.verified")).toHaveLength(1);
      // The professional learns only that a verified payment exists.
      const seen = await worker.agent.get(`${t.api}/bookings/${bookingId}`);
      expect(seen.body.payment).toEqual({ state: "PAID" });
    });

    it("does not trust a success redirect when the customer never paid", async () => {
      const { cust, ref, paymentId } = await started();
      // Nobody approved the payment inside bKash, but the browser claims success.
      const cb = await bkashCallback(t, ref, paymentId, "success");
      expect(cb.status).toBe(303);
      const status = await statusOf(cust, ref);
      expect(status).not.toBe("SUCCEEDED");
      expect(status).toBe("FAILED"); // execute was attempted and bKash still reports Initiated
      expect((await t.prisma.payment.findFirstOrThrow()).succeededAt).toBeNull();
    });

    it("ignores the status in the URL: a bare return page and a forged query change nothing", async () => {
      const { cust, ref, paymentId } = await started();
      expect((await cust.agent.get(`${t.api}/payments/${ref}?status=success`)).body.payment.status).toBe("INITIATED");
      const forged = await bkashCallback(t, ref, "SOME-OTHER-PAYMENT", "success");
      expect(forged.status).toBe(303);
      expect(await statusOf(cust, ref)).toBe("INITIATED");
      expect(t.net.callsTo("/payment/execute")).toHaveLength(0);
      expect(await count("payment.callback_rejected", ref)).toBe(1);
      expect(paymentId).toBeTruthy();
    });

    it("rejects an amount that differs from the agreed one (parked for review, booking not marked paid)", async () => {
      const { cust, bookingId, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId, { amount: "100.00" });
      await bkashCallback(t, ref, paymentId);
      const res = await paymentStatus(t, cust, ref);
      expect(res.body.payment.status).toBe("REQUIRES_REVIEW");
      expect(res.body.payment.needsAttention).toBe(true);
      expect(res.body.payment.refundableAmountBdt).toBe(0);
      const row = await t.prisma.payment.findFirstOrThrow();
      expect(row).toMatchObject({ reviewReason: "AMOUNT_MISMATCH", succeededAt: null });
      const booking = await cust.agent.get(`${t.api}/bookings/${bookingId}`);
      expect(booking.body.payment.state).toBe("UNDER_REVIEW");
      expect(booking.body.events.some((e: any) => e.type === "payment.verified")).toBe(false);
      // No second charge while money is unaccounted for.
      expect((await startPayment(t, cust, bookingId, "SSLCOMMERZ")).body.code).toBe("PAYMENT_UNDER_REVIEW");
    });

    it("handles repeated and parallel callbacks exactly once", async () => {
      const { cust, bookingId, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId);
      const burst = await Promise.all(Array.from({ length: 6 }, () => bkashCallback(t, ref, paymentId)));
      expect(burst.every((r) => r.status === 303)).toBe(true);
      await bkashCallback(t, ref, paymentId);
      await bkashCallback(t, ref, paymentId);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
      expect(t.net.callsTo("/payment/execute")).toHaveLength(1); // bKash allows one execute per payment
      expect(await count("payment.succeeded", ref)).toBe(1);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId, type: "payment.verified" } })).toBe(1);
      expect(await t.prisma.payment.count({ where: { status: "SUCCEEDED" } })).toBe(1);
    });

    it("never lets a late failure or cancel callback downgrade a verified payment", async () => {
      const { cust, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId);
      await bkashCallback(t, ref, paymentId);
      await bkashCallback(t, ref, paymentId, "failure");
      await bkashCallback(t, ref, paymentId, "cancel");
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
      expect(await count("payment.failed", ref)).toBe(0);
    });

    it("records a late success on a cancelled booking as paid-but-ineligible, without reviving the booking", async () => {
      const { cust, bookingId, ref, paymentId } = await started();
      const cancel = await cust.agent.post(`${t.api}/bookings/${bookingId}/cancel`).send({ reason: "Plans changed completely" });
      expect(cancel.status).toBe(200);
      t.net.bkashApprove(paymentId);
      await bkashCallback(t, ref, paymentId);
      const res = await paymentStatus(t, cust, ref);
      expect(res.body.payment).toMatchObject({ status: "SUCCEEDED", needsAttention: true, bookingIneligible: true });
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("CANCELLED");
    });

    it("keeps an ambiguous outcome PROCESSING (not failed) and resolves it later, executing only once", async () => {
      const { cust, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId);
      t.net.fail("/query/payment", "timeout", 3); // execute works, every confirmation attempt times out
      await bkashCallback(t, ref, paymentId);
      expect(await t.prisma.payment.findFirstOrThrow().then((p) => p.status)).toBe("PROCESSING");
      expect(await statusOf(cust, ref)).toBe("PROCESSING"); // 2nd timeout: still unknown, NOT failed
      pastThrottle(t);
      expect(await statusOf(cust, ref)).toBe("PROCESSING"); // 3rd timeout
      pastThrottle(t);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED"); // the provider answered at last
      expect(t.net.callsTo("/payment/execute")).toHaveLength(1);
      expect(await count("payment.succeeded", ref)).toBe(1);
    });

    it("retries execute later if bKash rejected the request before processing it (auth problem), then succeeds", async () => {
      const { cust, ref, paymentId } = await started();
      t.net.bkashApprove(paymentId);
      t.net.fail("/payment/execute", "http401", 1);
      await bkashCallback(t, ref, paymentId); // rejected before reaching bKash's payment logic
      expect(t.net.bkash.get(paymentId)!.executed).toBe(false);
      const row = await t.prisma.payment.findFirstOrThrow();
      expect(row.status).toBe("PROCESSING");
      expect(row.executeStartedAt).toBeNull(); // the single execute is still available
      pastThrottle(t);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
      expect(t.net.bkash.get(paymentId)!.executed).toBe(true);
    });

    it("expires an abandoned attempt only after the provider confirms nothing was paid", async () => {
      const { cust, ref } = await started();
      expect(await statusOf(cust, ref)).toBe("INITIATED");
      t.clock.advanceMinutes(31);
      expect(await statusOf(cust, ref)).toBe("EXPIRED");
      expect((await t.prisma.payment.findFirstOrThrow()).failureCode).toBe("ABANDONED");
    });

    it("cannot be completed after expiry: bKash charges only on execute, which an expired attempt never gets", async () => {
      const { cust, ref, paymentId } = await started();
      t.clock.advanceMinutes(31);
      expect(await statusOf(cust, ref)).toBe("EXPIRED");
      t.net.bkashApprove(paymentId);
      await bkashCallback(t, ref, paymentId);
      expect(await statusOf(cust, ref)).toBe("EXPIRED");
      expect(t.net.callsTo("/payment/execute")).toHaveLength(0); // nothing was charged
    });

    it("answers unknown or malformed references without error or information", async () => {
      for (const ref of ["FIN" + "0".repeat(24), "garbage", "FIN123"]) {
        const res = await bkashCallback(t, ref, "x");
        expect(res.status).toBe(303);
        expect(res.headers.location).toBe(`${WEB_ORIGIN}/payments`);
      }
    });
  });

  // ---------------------------------------------------------------- SSLCOMMERZ
  describe("SSLCOMMERZ verification", () => {
    async function started() {
      const ctx = await payableBooking(t);
      const res = await startPayment(t, ctx.cust, ctx.bookingId, "SSLCOMMERZ");
      return { ...ctx, ref: res.body.payment.reference as string, res };
    }
    const form = (ref: string, txn: { valId: string }, extra: Record<string, string> = {}) => ({ tran_id: ref, val_id: txn.valId, status: "VALID", ...extra });

    it("creates a hosted session with our callback URLs and never exposes the store password", async () => {
      const { res, ref } = await started();
      expect(res.body.checkoutUrl).toMatch(/^https:\/\/sandbox\.sslcommerz\.com\//);
      const sent = t.net.callsTo("gwprocess")[0]!.form!;
      expect(sent).toMatchObject({ tran_id: ref, currency: "BDT", total_amount: "500.00" });
      expect(sent.success_url).toBe(`${WEB_ORIGIN}/api/v1/payments/callbacks/sslcommerz/success`);
      expect(sent.ipn_url).toBe(`${WEB_ORIGIN}/api/v1/payments/ipn/sslcommerz`);
      expect(JSON.stringify(res.body)).not.toContain("DO-NOT-LEAK");
    });

    it("accepts a success callback only after the Validation API confirms it", async () => {
      const { cust, ref } = await started();
      const txn = t.net.sslPay(ref);
      const cb = await sslCallback(t, "success", form(ref, txn));
      expect(cb.status).toBe(303);
      expect(cb.headers.location).toBe(`${WEB_ORIGIN}/payments/${ref}?returned=1`);
      const res = await paymentStatus(t, cust, ref);
      expect(res.body.payment).toMatchObject({ status: "SUCCEEDED", providerTransactionId: txn.bankTranId });
      expect(t.net.callsTo("validationserverAPI").length).toBeGreaterThanOrEqual(1);
    });

    it("does not trust a success callback for a payment that was never made", async () => {
      const { cust, ref } = await started();
      const cb = await sslCallback(t, "success", { tran_id: ref, val_id: "FORGED", status: "VALID", amount: "500.00" });
      expect(cb.status).toBe(303);
      expect(await statusOf(cust, ref)).toBe("PROCESSING");
      expect((await t.prisma.payment.findFirstOrThrow()).succeededAt).toBeNull();
    });

    it("ignores a val_id that belongs to a different transaction (reference substitution)", async () => {
      const victim = await started();
      const other = await payableBooking(t);
      const otherRes = await startPayment(t, other.cust, other.bookingId, "SSLCOMMERZ");
      const otherRef = otherRes.body.payment.reference as string;
      const othersTxn = t.net.sslPay(otherRef); // a REAL, paid transaction... of someone else
      await sslCallback(t, "success", form(victim.ref, othersTxn));
      expect(await statusOf(victim.cust, victim.ref)).toBe("PROCESSING");
      expect(await count("payment.callback_rejected", victim.ref)).toBe(1);
      // ...and it did not poison the real owner of that transaction.
      await sslCallback(t, "success", form(otherRef, othersTxn));
      expect(await statusOf(other.cust, otherRef)).toBe("SUCCEEDED");
    });

    it("handles an IPN idempotently and answers with a fixed plain OK", async () => {
      const { cust, ref } = await started();
      const txn = t.net.sslPay(ref);
      const first = await sslIpn(t, form(ref, txn));
      expect(first.status).toBe(200);
      expect(first.text).toBe("OK");
      const before = (await events(t, ref)).length;
      await Promise.all([sslIpn(t, form(ref, txn)), sslIpn(t, form(ref, txn)), sslCallback(t, "success", form(ref, txn))]);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
      expect(await count("payment.succeeded", ref)).toBe(1);
      expect((await events(t, ref)).filter((e) => e.type === "payment.succeeded" || e.type === "payment.requires_review")).toHaveLength(1);
      expect(await t.prisma.bookingEvent.count({ where: { type: "payment.verified" } })).toBe(1);
      expect((await events(t, ref)).length - before).toBeLessThanOrEqual(2); // only new distinct facts, e.g. a different callback kind
      const unknown = await sslIpn(t, { tran_id: "FIN" + "A".repeat(24), val_id: "x", status: "VALID" });
      expect(unknown.status).toBe(200);
      expect(unknown.text).toBe("OK");
    });

    it("recovers a lost callback by looking the transaction up by our tran_id (polls are throttled)", async () => {
      const { cust, ref } = await started();
      expect(await statusOf(cust, ref)).toBe("INITIATED"); // looked up: nothing paid yet
      t.net.sslPay(ref); // paid, but no callback or IPN ever arrives
      const lookups = t.net.callsTo("merchantTransIDvalidationAPI").length;
      expect(await statusOf(cust, ref)).toBe("INITIATED"); // inside the throttle window: no provider call
      expect(t.net.callsTo("merchantTransIDvalidationAPI")).toHaveLength(lookups);
      pastThrottle(t);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
    });

    it("parks a duplicate payment instead of accepting a second success for the same booking", async () => {
      const { cust, bookingId, ref: first } = await started();
      t.clock.advanceMinutes(31);
      expect(await statusOf(cust, first)).toBe("EXPIRED"); // customer walked away from the first session
      const second = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      const secondRef = second.body.payment.reference as string;
      await sslCallback(t, "success", form(secondRef, t.net.sslPay(secondRef)));
      expect(await statusOf(cust, secondRef)).toBe("SUCCEEDED");
      // ...then the customer pays the OLD session after all (SSLCOMMERZ charges at the gateway).
      await sslCallback(t, "success", form(first, t.net.sslPay(first)));
      expect(await statusOf(cust, first)).toBe("REQUIRES_REVIEW");
      expect((await t.prisma.payment.findUniqueOrThrow({ where: { reference: first } })).reviewReason).toBe("DUPLICATE_PAYMENT");
      expect(await statusOf(cust, secondRef)).toBe("SUCCEEDED");
      expect(await t.prisma.payment.count({ where: { bookingId, status: "SUCCEEDED" } })).toBe(1);
      expect(await t.prisma.bookingEvent.count({ where: { bookingId, type: "payment.verified" } })).toBe(1);
    });

    it("rejects mismatching amount, currency, and provider-flagged risk", async () => {
      for (const [opts, reason] of [
        [{ amount: "10.00" }, "AMOUNT_MISMATCH"],
        [{ currency: "USD" }, "CURRENCY_MISMATCH"],
        [{ risk: "1" }, "PROVIDER_RISK_FLAG"],
      ] as const) {
        await t.resetData();
        const { cust, ref } = await started();
        const txn = t.net.sslPay(ref, opts);
        await sslCallback(t, "success", form(ref, txn));
        expect(await statusOf(cust, ref), reason).toBe("REQUIRES_REVIEW");
        expect((await t.prisma.payment.findFirstOrThrow()).reviewReason).toBe(reason);
      }
    });

    it("records fail and cancel callbacks, allows a retry, and still accepts a verified late payment", async () => {
      const { cust, bookingId, ref } = await started();
      await sslCallback(t, "cancel", { tran_id: ref, status: "CANCELLED" });
      expect(await statusOf(cust, ref)).toBe("CANCELLED");
      const retry = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      expect(retry.status).toBe(201);
      const retryRef = retry.body.payment.reference as string;
      await sslCallback(t, "fail", { tran_id: retryRef, status: "FAILED" });
      expect(await statusOf(cust, retryRef)).toBe("FAILED");
      // The customer in fact paid the first session before cancelling it.
      const txn = t.net.sslPay(ref);
      await sslIpn(t, form(ref, txn));
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
      await sslCallback(t, "fail", { tran_id: ref, status: "FAILED" });
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED"); // never downgraded
    });

    it("keeps PROCESSING while the Validation API is down and resolves once it answers", async () => {
      const { cust, ref } = await started();
      const txn = t.net.sslPay(ref);
      t.net.fail("validationserverAPI", "http500", 1);
      await sslCallback(t, "success", form(ref, txn));
      expect(await t.prisma.payment.findFirstOrThrow().then((p) => p.status)).toBe("PROCESSING");
      pastThrottle(t);
      expect(await statusOf(cust, ref)).toBe("SUCCEEDED");
    });
  });

  // ---------------------------------------------------------------- history, privacy, security
  describe("history, privacy and security", () => {
    it("keeps payment history private to its owner", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "BKASH");
      const ref = res.body.payment.reference as string;
      const stranger = await customer(t);
      expect((await paymentStatus(t, stranger, ref)).status).toBe(404);
      expect((await stranger.agent.get(`${t.api}/payments`)).body.payments).toEqual([]);
      expect((await paymentStatus(t, cust, "nonsense")).status).toBe(404);
      const mine = await cust.agent.get(`${t.api}/payments`);
      expect(mine.body.total).toBe(1);
      expect(mine.body.payments[0]).toMatchObject({ reference: ref, booking: { serviceName: expect.any(String) } });
      const admin = await t.newAdmin();
      expect((await paymentStatus(t, admin, ref)).status).toBe(404); // admins use the admin API
    });

    it("never returns credentials, provider session ids, checkout URLs or database ids on read endpoints", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      const ref = res.body.payment.reference as string;
      const txn = t.net.sslPay(ref);
      await sslCallback(t, "success", { tran_id: ref, val_id: txn.valId, status: "VALID" });
      const row = await t.prisma.payment.findFirstOrThrow();
      const bodies = [
        (await paymentStatus(t, cust, ref)).body,
        (await cust.agent.get(`${t.api}/payments`)).body,
        (await cust.agent.get(`${t.api}/payments/providers`)).body,
        (await cust.agent.get(`${t.api}/bookings/${bookingId}`)).body,
      ].map((b) => JSON.stringify(b));
      for (const body of bodies) {
        for (const secret of [...SECRET_MARKERS, row.id, row.providerPaymentId!, row.providerValidationId!, "checkoutUrl", "gwprocess", row.customerId]) {
          expect(body, `leaked ${secret}`).not.toContain(secret);
        }
      }
    });

    it("stores no credentials or provider payloads in payment events", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const a = await startPayment(t, cust, bookingId, "BKASH");
      const id = latestBkashId(t);
      t.net.bkashApprove(id);
      await bkashCallback(t, a.body.payment.reference, id);
      const all = JSON.stringify(await t.prisma.paymentEvent.findMany());
      for (const secret of [...SECRET_MARKERS, "id_token", "tok-", "payerAccount", "signature"]) expect(all).not.toContain(secret);
    });

    it("makes the payment history append-only at the database level", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "BKASH");
      const event = (await events(t, res.body.payment.reference))[0]!;
      await expect(t.prisma.paymentEvent.update({ where: { id: event.id }, data: { type: "payment.succeeded" } })).rejects.toThrow(/append-only/);
      await expect(t.prisma.paymentEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
    });

    it("enforces one paid payment and one open attempt per booking in the database itself", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const a = await startPayment(t, cust, bookingId, "BKASH");
      const row = await t.prisma.payment.findFirstOrThrow({ where: { reference: a.body.payment.reference } });
      const clone = { bookingId, customerId: row.customerId, provider: "BKASH" as const, amountBdt: 500 };
      await expect(t.prisma.payment.create({ data: { ...clone, reference: "FIN" + "B".repeat(24), status: "INITIATED" } })).rejects.toThrow();
      await t.prisma.payment.update({ where: { id: row.id }, data: { status: "SUCCEEDED", providerTransactionId: "T1" } });
      await expect(t.prisma.payment.create({ data: { ...clone, reference: "FIN" + "C".repeat(24), status: "SUCCEEDED", providerTransactionId: "T2" } })).rejects.toThrow();
      await expect(t.prisma.payment.update({ where: { id: row.id }, data: { providerTransactionId: null } })).rejects.toThrow();
      await expect(t.prisma.payment.update({ where: { id: row.id }, data: { amountBdt: 0 } })).rejects.toThrow();
      await expect(t.prisma.payment.update({ where: { id: row.id }, data: { refundedAmountBdt: 501 } })).rejects.toThrow();
    });

    it("keeps the browser CSRF check on every route except the provider callbacks", async () => {
      const { cust, bookingId } = await payableBooking(t);
      // A cross-site page cannot start a payment with the customer's cookies...
      const forged = await cust.agent.post(`${t.api}/bookings/${bookingId}/payments`).set("Origin", "https://evil.example.com").send({ provider: "BKASH" });
      expect(forged.status).toBe(403);
      expect(await t.prisma.payment.count()).toBe(0);
      // ...while the provider callback routes (cross-site by nature) are reachable without one.
      expect((await sslIpn(t, { tran_id: "x" })).status).toBe(200);
    });

    it("lets only administrators use the admin payment API", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "BKASH");
      const ref = res.body.payment.reference as string;
      for (const [method, path] of [["get", "admin/payments"], ["get", `admin/payments/${ref}`], ["post", `admin/payments/${ref}/reconcile`], ["post", "admin/payments/reconcile-stale"], ["get", "admin/refunds"]] as const) {
        expect((await cust.agent[method](`${t.api}/${path}`).send({})).status, path).toBe(403);
        expect((await t.client()[method](`${t.api}/${path}`).send({})).status, path).toBe(401);
      }
    });

    it("lets an administrator reconcile an unresolved payment, with an audit entry, discovering a lost success", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      const ref = res.body.payment.reference as string;
      t.net.sslPay(ref); // paid; every notification was lost
      const admin = await t.newAdmin();
      const out = await admin.agent.post(`${t.api}/admin/payments/${ref}/reconcile`).send({});
      expect(out.status).toBe(200);
      expect(out.body.payment.status).toBe("SUCCEEDED");
      expect(await t.prisma.auditLog.count({ where: { action: "payment.reconcile", actorId: admin.userId } })).toBe(1);
      // Idempotent: repeating it changes nothing.
      await admin.agent.post(`${t.api}/admin/payments/${ref}/reconcile`).send({});
      expect(await count("payment.succeeded", ref)).toBe(1);
      const queue = await admin.agent.get(`${t.api}/admin/payments?status=SUCCEEDED`);
      expect(queue.body.payments).toHaveLength(1);
      expect(JSON.stringify(queue.body)).not.toMatch(/@example\.com|customerId|providerPaymentId/);
    });

    it("re-verifies stale unresolved payments in a batch", async () => {
      const { cust, bookingId } = await payableBooking(t);
      const res = await startPayment(t, cust, bookingId, "SSLCOMMERZ");
      const ref = res.body.payment.reference as string;
      t.net.sslPay(ref);
      t.clock.advanceMinutes(5);
      const admin = await t.newAdmin();
      const out = await admin.agent.post(`${t.api}/admin/payments/reconcile-stale`).send({});
      expect(out.body).toEqual({ checked: 1, statuses: { SUCCEEDED: 1 } });
    });

    it("does not let an administrator reconcile a payment on a booking they take part in", async () => {
      const admin = await t.newAdmin();
      const worker = await bookableWorker(t);
      const bookingId = await (async () => {
        const created = await requestBooking(t, admin, worker, at(t, 3, 10));
        await worker.agent.post(`${t.api}/bookings/${created.body.booking.id}/accept`).send({});
        return created.body.booking.id as string;
      })();
      const res = await startPayment(t, admin, bookingId, "BKASH");
      const out = await admin.agent.post(`${t.api}/admin/payments/${res.body.payment.reference}/reconcile`).send({});
      expect(out.status).toBe(404);
    });
  });

  it("uses a fixed set of callback routes that need no session", async () => {
    expect((await raw(t).get(`${t.api}/payments/callbacks/sslcommerz/success`)).status).toBe(404);
    expect((await raw(t).post(`${t.api}/payments/callbacks/sslcommerz/bogus`).type("form").send({})).status).toBe(404);
    expect((await sslCallback(t, "success", {})).headers.location).toBe(`${WEB_ORIGIN}/payments`);
  });
});
