import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import { HttpClient, HttpUnreachableError, type HttpRequest, type HttpResponse } from "./http.js";
import { SslcommerzAdapter } from "./sslcommerz.adapter.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  FRONTEND_ORIGIN: "http://localhost:3000",
  SSLCOMMERZ_STORE_ID: "store", SSLCOMMERZ_STORE_PASSWORD: "pw",
};
const cfg = loadEnv(base).sslcommerz!;

/** MOCKED SSLCOMMERZ: scripted by endpoint file name. */
class Script extends HttpClient {
  calls: HttpRequest[] = [];
  constructor(private readonly handler: (req: HttpRequest) => HttpResponse | Error) {
    super();
  }
  override async request(req: HttpRequest) {
    this.calls.push(req);
    const out = this.handler(req);
    if (out instanceof Error) throw out;
    return out;
  }
}
const make = (handler: ConstructorParameters<typeof Script>[0], c = cfg) => {
  const http = new Script(handler);
  return { http, ssl: new SslcommerzAdapter(c, http) };
};
const ctx = { reference: "FIN1", providerPaymentId: "S1", providerValidationId: null, amountBdt: 500 };
const valid = { status: "VALID", tran_id: "FIN1", val_id: "V1", amount: "500.00", currency: "BDT", currency_type: "BDT", currency_amount: "500.00", bank_tran_id: "B1", risk_level: "0" };

describe("SslcommerzAdapter (mocked)", () => {
  it("opens a hosted session with the documented fields against the sandbox host", async () => {
    const { http, ssl } = make(() => ({ status: 200, body: { status: "SUCCESS", sessionkey: "S1", GatewayPageURL: "https://sandbox.sslcommerz.com/gw?Q=1" } }));
    const urls = { callback: "", success: "https://app/s", fail: "https://app/f", cancel: "https://app/c", ipn: "https://app/i" };
    const out = await ssl.initiate({ reference: "FIN1", amountBdt: 500, urls, customer: { name: "Rahim", email: "r@example.com" }, productName: "Electrical" });
    expect(out).toEqual({ kind: "ok", providerPaymentId: "S1", checkoutUrl: "https://sandbox.sslcommerz.com/gw?Q=1" });
    const call = http.calls[0]!;
    expect(call.url).toBe("https://sandbox.sslcommerz.com/gwprocess/v4/api.php");
    expect(call.method).toBe("POST");
    expect(call.form).toMatchObject({ store_id: "store", store_passwd: "pw", total_amount: "500.00", currency: "BDT", tran_id: "FIN1", success_url: "https://app/s", fail_url: "https://app/f", cancel_url: "https://app/c", ipn_url: "https://app/i", cus_email: "r@example.com" });
  });

  it("uses the live host only when configured live", async () => {
    const live = loadEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://app.example.com", FRONTEND_ORIGIN: "https://app.example.com", MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", TRUSTED_PROXIES: "10.0.0.1", SSLCOMMERZ_IS_LIVE: "true" }).sslcommerz!;
    const { http, ssl } = make(() => ({ status: 200, body: { status: "FAILED" } }), live);
    await ssl.initiate({ reference: "FIN1", amountBdt: 500, urls: { callback: "", success: "", fail: "", cancel: "", ipn: "" }, customer: { name: "A", email: "a@b.c" }, productName: "x" });
    expect(http.calls[0]!.url.startsWith("https://securepay.sslcommerz.com/")).toBe(true);
    expect(ssl.isLive).toBe(true);
  });

  it("classifies session failures and never stores the provider's free-text reason", async () => {
    const run = (res: HttpResponse | Error) => make(() => res).ssl.initiate({ reference: "F", amountBdt: 500, urls: { callback: "", success: "", fail: "", cancel: "", ipn: "" }, customer: { name: "A", email: "a@b.c" }, productName: "x" });
    expect(await run({ status: 200, body: { status: "FAILED", failedreason: "Store Credential Error: user=store" } })).toEqual({ kind: "rejected", code: "SESSION_FAILED" });
    expect(await run({ status: 200, body: { status: "SUCCESS" } })).toEqual({ kind: "rejected", code: "BAD_RESPONSE" });
    expect(await run(new HttpUnreachableError("network"))).toEqual({ kind: "unreachable", code: "NETWORK" });
    expect(await run({ status: 500, body: undefined })).toEqual({ kind: "unreachable", code: "HTTP_500" });
  });

  it("validates a val_id through the Order Validation API and reports the amounts it returned", async () => {
    const { http, ssl } = make(() => ({ status: 200, body: valid }));
    const out = await ssl.verify({ ...ctx, providerValidationId: "V1" });
    expect(out).toEqual({ kind: "completed", reference: "FIN1", providerPaymentId: null, providerTransactionId: "B1", providerValidationId: "V1", amountPoisha: 50_000, currency: "BDT", riskFlagged: false });
    expect(http.calls[0]).toMatchObject({ method: "GET", url: "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php", query: { val_id: "V1", store_id: "store", store_passwd: "pw", format: "json" } });
  });

  it("accepts VALIDATED (already validated) and flags risky transactions", async () => {
    expect((await make(() => ({ status: 200, body: { ...valid, status: "VALIDATED" } })).ssl.validate("V1")).kind).toBe("completed");
    expect(await make(() => ({ status: 200, body: { ...valid, risk_level: "1" } })).ssl.validate("V1")).toMatchObject({ riskFlagged: true });
  });

  it("reports no amount when the order and settlement figures disagree, so it can only be a mismatch", async () => {
    expect(await make(() => ({ status: 200, body: { ...valid, currency_amount: "400.00" } })).ssl.validate("V1")).toMatchObject({ amountPoisha: null });
    expect(await make(() => ({ status: 200, body: { ...valid, currency: "USD" } })).ssl.validate("V1")).toMatchObject({ amountPoisha: null });
    expect(await make(() => ({ status: 200, body: { ...valid, amount: "abc" } })).ssl.validate("V1")).toMatchObject({ amountPoisha: null });
    expect(await make(() => ({ status: 200, body: { ...valid, currency_type: "USD" } })).ssl.validate("V1")).toMatchObject({ currency: "USD" });
  });

  it("treats anything but VALID/VALIDATED as not paid, and outages as unknown", async () => {
    const v = (res: HttpResponse | Error) => make(() => res).ssl.validate("V1");
    expect(await v({ status: 200, body: { status: "INVALID_TRANSACTION" } })).toEqual({ kind: "not_completed", state: "unknown" });
    expect(await v({ status: 200, body: { status: "FAILED" } })).toEqual({ kind: "indeterminate", code: "STATUS_FAILED" });
    expect(await v({ status: 200, body: { ...valid, bank_tran_id: undefined } })).toEqual({ kind: "indeterminate", code: "MISSING_BANK_TRAN_ID" });
    expect(await v({ status: 503, body: undefined })).toEqual({ kind: "indeterminate", code: "HTTP_503" });
    expect(await v({ status: 200, body: undefined })).toEqual({ kind: "indeterminate", code: "BAD_RESPONSE" });
    expect(await v(new HttpUnreachableError("timeout"))).toEqual({ kind: "indeterminate", code: "TIMEOUT" });
  });

  it("without a val_id it looks the transaction up by tran_id and then validates the val_id it finds", async () => {
    const { http, ssl } = make((req) =>
      req.url.endsWith("merchantTransIDvalidationAPI.php")
        ? { status: 200, body: { APIConnect: "DONE", no_of_trans_found: 2, element: [{ status: "FAILED", val_id: "" }, { status: "VALID", val_id: "V1" }] } }
        : { status: 200, body: valid },
    );
    expect((await ssl.verify(ctx)).kind).toBe("completed");
    expect(http.calls.map((c) => c.url.split("/").pop())).toEqual(["merchantTransIDvalidationAPI.php", "validationserverAPI.php"]);
    expect(http.calls[0]!.query).toMatchObject({ tran_id: "FIN1" });
  });

  it("maps lookup results: none, pending, failed, and ambiguous", async () => {
    const lookup = (element: unknown[], connect = "DONE") => make(() => ({ status: 200, body: { APIConnect: connect, element } })).ssl.verify(ctx);
    expect(await lookup([])).toEqual({ kind: "not_completed", state: "unknown" });
    expect(await lookup([{ status: "PENDING" }])).toEqual({ kind: "not_completed", state: "pending" });
    expect(await lookup([{ status: "FAILED" }])).toEqual({ kind: "not_completed", state: "failed" });
    expect(await lookup([{ status: "VALID", val_id: "A" }, { status: "VALID", val_id: "B" }])).toEqual({ kind: "indeterminate", code: "MULTIPLE_VALID_TRANSACTIONS" });
    expect(await lookup([], "INACTIVE")).toEqual({ kind: "indeterminate", code: "API_INACTIVE" });
  });

  it("requests refunds by bank_tran_id with a unique refund id, and confirms via refund_ref_id", async () => {
    const { http, ssl } = make((req) =>
      req.query?.refund_ref_id
        ? { status: 200, body: { APIConnect: "DONE", refund_ref_id: "REF1", status: "refunded" } }
        : { status: 200, body: { APIConnect: "DONE", status: "success", refund_ref_id: "REF1", bank_tran_id: "B1" } },
    );
    const input = { providerPaymentId: "S1", providerTransactionId: "B1", refundReference: "RFD1", amountBdt: 200, reason: "r", paymentReference: "FIN1" };
    expect(await ssl.refund(input)).toEqual({ kind: "accepted", providerRefundId: "REF1" });
    expect(http.calls[0]!.query).toMatchObject({ bank_tran_id: "B1", refund_trans_id: "RFD1", refund_amount: "200.00", refund_remarks: "r", refe_id: "FIN1" });
    expect(await ssl.refundStatus({ ...input, providerRefundId: "REF1" })).toEqual({ kind: "refunded", providerRefundId: "REF1", amountPoisha: null });
  });

  it("classifies refund answers without inventing success", async () => {
    const input = { providerPaymentId: "S1", providerTransactionId: "B1", refundReference: "RFD1", amountBdt: 200, reason: "r", paymentReference: "FIN1" };
    const refund = (body: unknown) => make(() => ({ status: 200, body })).ssl.refund(input);
    expect(await refund({ APIConnect: "DONE", status: "failed", errorReason: "secret detail" })).toEqual({ kind: "rejected", code: "REFUND_FAILED" });
    expect(await refund({ APIConnect: "DONE", status: "success" })).toEqual({ kind: "indeterminate", code: "UNEXPECTED_REFUND_RESPONSE" }); // no refund_ref_id
    expect(await refund({ APIConnect: "INVALID_REQUEST" })).toEqual({ kind: "rejected", code: "API_INVALID_REQUEST" });
    const status = (body: unknown, id: string | null = "REF1") => make(() => ({ status: 200, body })).ssl.refundStatus({ ...input, providerRefundId: id });
    expect(await status({ APIConnect: "DONE", status: "processing" })).toEqual({ kind: "processing" });
    expect(await status({ APIConnect: "DONE", status: "cancelled" })).toEqual({ kind: "failed", code: "REFUND_CANCELLED" });
    expect(await status({ APIConnect: "DONE", status: "refunded", refund_ref_id: "OTHER" })).toEqual({ kind: "indeterminate", code: "REFUND_REF_MISMATCH" });
    expect(await status({ APIConnect: "DONE", status: "refunded" }, null)).toEqual({ kind: "indeterminate", code: "MISSING_REFUND_REF" });
  });
});
