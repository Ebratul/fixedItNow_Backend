import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import { HttpClient, HttpUnreachableError, type HttpRequest, type HttpResponse } from "./http.js";
import { BkashAdapter } from "./bkash.adapter.js";

const BASE = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout";
const cfg = loadEnv({
  DATABASE_URL: "postgresql://u:p@localhost/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  FRONTEND_ORIGIN: "http://localhost:3000",
  BKASH_BASE_URL: BASE, BKASH_APP_KEY: "key", BKASH_APP_SECRET: "secret", BKASH_USERNAME: "user", BKASH_PASSWORD: "pass",
}).bkash!;

/** MOCKED bKash: scripted per path. This verifies request building and response parsing only. */
class Script extends HttpClient {
  calls: HttpRequest[] = [];
  constructor(private readonly routes: Record<string, (req: HttpRequest) => HttpResponse | Error>) {
    super();
  }
  override async request(req: HttpRequest) {
    this.calls.push(req);
    const handler = this.routes[req.url.slice(BASE.length)];
    if (!handler) throw new Error(`unscripted ${req.url}`);
    const out = handler(req);
    if (out instanceof Error) throw out;
    return out;
  }
}
const grant = () => ({ status: 200, body: { statusCode: "0000", id_token: "TOKEN-1", expires_in: 3600 } });
const ctx = { reference: "FIN1", providerPaymentId: "P1", providerValidationId: null, amountBdt: 500 };
const adapter = (routes: ConstructorParameters<typeof Script>[0], now = () => 1_000_000) => {
  const http = new Script({ "/auth/grant-token": grant, ...routes });
  return { http, bkash: new BkashAdapter(cfg, http, now) };
};
const urls = { callback: "https://app/cb", success: "", fail: "", cancel: "", ipn: "" };

describe("BkashAdapter (mocked)", () => {
  it("authenticates with the documented grant-token request and caches the token", async () => {
    const { http, bkash } = adapter({ "/query/payment": () => ({ status: 200, body: { externalCode: "2002", errorMessageEn: "Invalid" } }) });
    await bkash.verify(ctx);
    await bkash.verify(ctx);
    const grants = http.calls.filter((c) => c.url.endsWith("/auth/grant-token"));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ method: "POST", headers: { username: "user", password: "pass" }, json: { app_key: "key", app_secret: "secret" } });
    const query = http.calls.find((c) => c.url.endsWith("/query/payment"))!;
    expect(query.headers).toMatchObject({ Authorization: "Bearer TOKEN-1", "X-APP-Key": "key" });
  });

  it("shares ONE grant between concurrent calls (grant-token is limited to 2/hour)", async () => {
    const { http, bkash } = adapter({ "/query/payment": () => ({ status: 200, body: { transactionStatus: "Initiated" } }) });
    await Promise.all([bkash.verify(ctx), bkash.verify(ctx), bkash.verify(ctx)]);
    expect(http.calls.filter((c) => c.url.endsWith("/auth/grant-token"))).toHaveLength(1);
  });

  it("backs off after a failed grant instead of hammering the rate-limited endpoint", async () => {
    let clock = 1_000_000;
    const { http, bkash } = adapter({ "/auth/grant-token": () => ({ status: 200, body: { statusCode: "9999", statusMessage: "bad" } }) }, () => clock);
    expect(await bkash.verify(ctx)).toEqual({ kind: "indeterminate", code: "TOKEN_UNAVAILABLE" });
    expect(await bkash.verify(ctx)).toEqual({ kind: "indeterminate", code: "TOKEN_UNAVAILABLE" });
    expect(http.calls.filter((c) => c.url.endsWith("/auth/grant-token"))).toHaveLength(1);
    clock += 6 * 60_000;
    await bkash.verify(ctx);
    expect(http.calls.filter((c) => c.url.endsWith("/auth/grant-token"))).toHaveLength(2);
  });

  it("refreshes an expired token", async () => {
    let clock = 0;
    const { http, bkash } = adapter({ "/query/payment": () => ({ status: 200, body: { transactionStatus: "Initiated" } }) }, () => clock);
    await bkash.verify(ctx);
    clock = 3_600_000; // past expires_in
    await bkash.verify(ctx);
    expect(http.calls.filter((c) => c.url.endsWith("/auth/grant-token"))).toHaveLength(2);
  });

  it("creates a payment with a decimal-string amount, our invoice number and callback, and returns the bKash URL", async () => {
    const { http, bkash } = adapter({
      "/payment/create": (req) => ({ status: 200, body: { paymentId: "P9", bKashURL: "https://sbpayment.bka.sh/x", merchantInvoiceNumber: (req.json as any).merchantInvoiceNumber, amount: "500.00" } }),
    });
    const out = await bkash.initiate({ reference: "FIN1", amountBdt: 500, urls, customer: { name: "A", email: "a@b.c" }, productName: "x" });
    expect(out).toEqual({ kind: "ok", providerPaymentId: "P9", checkoutUrl: "https://sbpayment.bka.sh/x" });
    expect(http.calls.find((c) => c.url.endsWith("/payment/create"))!.json).toEqual({
      payerReference: "FIN1", callbackURL: "https://app/cb", amount: "500.00", currency: "BDT", intent: "sale", merchantInvoiceNumber: "FIN1",
    });
  });

  it("classifies create failures: provider refusal vs unreachable vs inconsistent echo", async () => {
    const make = (res: HttpResponse | Error) => adapter({ "/payment/create": () => res }).bkash.initiate({ reference: "FIN1", amountBdt: 500, urls, customer: { name: "A", email: "a@b.c" }, productName: "x" });
    expect(await make({ status: 200, body: { externalCode: "2007", errorMessageEn: "Invalid currency" } })).toEqual({ kind: "rejected", code: "2007" });
    expect(await make(new HttpUnreachableError("timeout"))).toEqual({ kind: "unreachable", code: "TIMEOUT" });
    expect(await make({ status: 503, body: undefined })).toEqual({ kind: "unreachable", code: "HTTP_503" });
    expect(await make({ status: 200, body: { paymentId: "P", bKashURL: "https://x.bka.sh", merchantInvoiceNumber: "SOMETHING-ELSE" } })).toEqual({ kind: "rejected", code: "ECHO_MISMATCH" });
    expect(await make({ status: 200, body: { paymentId: "P", bKashURL: "https://x.bka.sh", amount: "1.00" } })).toEqual({ kind: "rejected", code: "ECHO_MISMATCH" });
    expect(await make({ status: 200, body: { paymentId: "P" } })).toEqual({ kind: "rejected", code: "BAD_RESPONSE" });
  });

  it("reads a completed query only with Completed + trxId, and reports what bKash said (not what we hoped)", async () => {
    const body = { paymentId: "P1", transactionStatus: "Completed", trxId: "T1", amount: "500.00", currency: "BDT", merchantInvoice: "FIN1", verificationStatus: "Complete" };
    const completed = await adapter({ "/query/payment": () => ({ status: 200, body }) }).bkash.verify(ctx);
    expect(completed).toEqual({ kind: "completed", reference: "FIN1", providerPaymentId: "P1", providerTransactionId: "T1", providerValidationId: null, amountPoisha: 50_000, currency: "BDT", riskFlagged: false });
    const wrongAmount = await adapter({ "/query/payment": () => ({ status: 200, body: { ...body, amount: "5.00" } }) }).bkash.verify(ctx);
    expect(wrongAmount).toMatchObject({ kind: "completed", amountPoisha: 500 });
    expect(await adapter({ "/query/payment": () => ({ status: 200, body: { ...body, trxId: undefined } }) }).bkash.verify(ctx)).toEqual({ kind: "indeterminate", code: "MISSING_TRX_ID" });
    expect(await adapter({ "/query/payment": () => ({ status: 200, body: { ...body, verificationStatus: "Incomplete" } }) }).bkash.verify(ctx)).toEqual({ kind: "not_completed", state: "pending" });
    expect(await adapter({ "/query/payment": () => ({ status: 200, body: { ...body, paymentId: "OTHER" } }) }).bkash.verify(ctx)).toEqual({ kind: "indeterminate", code: "PAYMENT_ID_MISMATCH" });
  });

  it("maps the other query results conservatively", async () => {
    const q = (res: HttpResponse | Error) => adapter({ "/query/payment": () => res }).bkash.verify(ctx);
    expect(await q({ status: 200, body: { transactionStatus: "Initiated" } })).toEqual({ kind: "not_completed", state: "pending" });
    expect(await q({ status: 200, body: { externalCode: "2002" } })).toEqual({ kind: "not_completed", state: "unknown" });
    expect(await q({ status: 200, body: { externalCode: "9000" } })).toEqual({ kind: "indeterminate", code: "BKASH_9000" });
    expect(await q({ status: 200, body: { transactionStatus: "Weird" } })).toEqual({ kind: "indeterminate", code: "UNEXPECTED_STATUS" });
    expect(await q({ status: 200, body: "not json" })).toEqual({ kind: "indeterminate", code: "BAD_RESPONSE" });
    expect(await q({ status: 502, body: undefined })).toEqual({ kind: "indeterminate", code: "HTTP_502" });
    expect(await q(new HttpUnreachableError("timeout"))).toEqual({ kind: "indeterminate", code: "TIMEOUT" });
    expect(await q({ status: 401, body: {} })).toEqual({ kind: "indeterminate", code: "AUTH_ERROR" });
    expect(await adapter({}).bkash.verify({ ...ctx, providerPaymentId: null })).toEqual({ kind: "not_completed", state: "unknown" });
  });

  it("executes once, then confirms with a query (the execute response is never trusted)", async () => {
    const { http, bkash } = adapter({
      "/payment/execute": () => ({ status: 200, body: { paymentId: "P1", trxId: "T1", transactionStatus: "Completed", amount: "500.00" } }),
      "/query/payment": () => ({ status: 200, body: { paymentId: "P1", transactionStatus: "Initiated" } }), // bKash disagrees
    });
    const out = await bkash.completeAfterApproval(ctx);
    expect(out.executed).toBe(true);
    expect(out.verification).toEqual({ kind: "not_completed", state: "pending" });
    expect(http.calls.map((c) => c.url.replace(BASE, ""))).toEqual(["/auth/grant-token", "/payment/execute", "/query/payment"]);
  });

  it("queries after an execute timeout (docs), and reports an execute that never left as not executed", async () => {
    const timeout = adapter({
      "/payment/execute": () => new HttpUnreachableError("timeout"),
      "/query/payment": () => ({ status: 200, body: { paymentId: "P1", transactionStatus: "Completed", trxId: "T1", amount: "500.00", currency: "BDT", merchantInvoice: "FIN1" } }),
    });
    const a = await timeout.bkash.completeAfterApproval(ctx);
    expect(a.executed).toBe(true);
    expect(a.verification.kind).toBe("completed");

    const denied = adapter({ "/payment/execute": () => ({ status: 401, body: {} }), "/query/payment": () => ({ status: 200, body: { transactionStatus: "Initiated" } }) });
    expect((await denied.bkash.completeAfterApproval(ctx)).executed).toBe(false);
  });

  it("sends refunds with the documented fields and reads the refund status list", async () => {
    const { http, bkash } = adapter({
      "/refund/payment/transaction": () => ({ status: 200, body: { originalTrxId: "T1", refundTrxId: "R1", refundTransactionStatus: "Completed", refundAmount: "200.00" } }),
      "/refund/payment/status": () => ({
        status: 200,
        body: { originalTrxId: "T1", refundTransactions: [{ refundTrxId: "R0", refundTransactionStatus: "Completed", refundAmount: "5.00" }, { refundTrxId: "R1", refundTransactionStatus: "Completed", refundAmount: "200.00" }] },
      }),
    });
    const input = { providerPaymentId: "P1", providerTransactionId: "T1", refundReference: "RFD1", amountBdt: 200, reason: "x".repeat(400), paymentReference: "FIN1" };
    expect(await bkash.refund(input)).toEqual({ kind: "accepted", providerRefundId: "R1" });
    expect(http.calls.find((c) => c.url.endsWith("/refund/payment/transaction"))!.json).toEqual({
      paymentId: "P1", trxId: "T1", refundAmount: "200.00", sku: "service-booking", reason: "x".repeat(255),
    });
    expect(await bkash.refundStatus({ ...input, providerRefundId: "R1" })).toEqual({ kind: "refunded", providerRefundId: "R1", amountPoisha: 20_000 });
    expect(await bkash.refundStatus({ ...input, providerRefundId: "R9" })).toEqual({ kind: "indeterminate", code: "REFUND_NOT_LISTED" });
  });

  it("does not guess when a refund response is unusable", async () => {
    const r = (res: HttpResponse | Error) => adapter({ "/refund/payment/transaction": () => res }).bkash.refund({ providerPaymentId: "P1", providerTransactionId: "T1", refundReference: "R", amountBdt: 1, reason: "r", paymentReference: "F" });
    expect(await r({ status: 200, body: { externalCode: "2072" } })).toEqual({ kind: "rejected", code: "2072" });
    expect(await r({ status: 200, body: { refundTransactionStatus: "Completed" } })).toEqual({ kind: "indeterminate", code: "MISSING_REFUND_ID" });
    expect(await r(new HttpUnreachableError("timeout"))).toEqual({ kind: "indeterminate", code: "TIMEOUT" });
  });

  it("reduces provider-supplied codes to short safe tokens before they are stored", async () => {
    const { bkash } = adapter({ "/query/payment": () => ({ status: 200, body: { externalCode: "<script>alert(1)</script>".repeat(5) } }) });
    const out = await bkash.verify(ctx);
    expect(out.kind).toBe("indeterminate");
    expect((out as { code: string }).code).toMatch(/^BKASH_[A-Za-z0-9_.-]{1,40}$/);
  });
});
