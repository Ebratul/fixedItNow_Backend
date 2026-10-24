import { HttpClient, HttpUnreachableError, type HttpRequest, type HttpResponse } from "../src/payments/providers/http.js";

/**
 * A deterministic stand-in for bKash and SSLCOMMERZ for AUTOMATED TESTS ONLY.
 *
 * It models just enough provider behaviour (sessions, customer approval,
 * execute-once, validation, refunds) to exercise OUR logic. It is NOT evidence
 * that the real providers behave this way: that needs the providers' sandboxes
 * (docs/PAYMENTS.md). Nothing here reaches the network.
 */

export const BKASH_BASE = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout";
export const SSL_HOST = "https://sandbox.sslcommerz.com";

export const TEST_ENV = {
  BKASH_BASE_URL: BKASH_BASE,
  BKASH_APP_KEY: "test-app-key",
  BKASH_APP_SECRET: "test-app-secret-DO-NOT-LEAK",
  BKASH_USERNAME: "test-user",
  BKASH_PASSWORD: "test-pass-DO-NOT-LEAK",
  BKASH_REFUNDS_ENABLED: "true",
  SSLCOMMERZ_STORE_ID: "teststore",
  SSLCOMMERZ_STORE_PASSWORD: "test-store-pass-DO-NOT-LEAK",
  SSLCOMMERZ_REFUNDS_ENABLED: "true",
};
export const SECRET_MARKERS = ["DO-NOT-LEAK", "test-app-key", "teststore"];

type BkashPayment = {
  paymentId: string;
  invoice: string;
  amount: string;
  approved: boolean;
  executed: boolean;
  status: "Initiated" | "Completed";
  trxId?: string;
  paidAmount?: string;
  refunds: { refundTrxId: string; amount: string; status: string }[];
};
type SslSession = { tran: string; amount: string; sessionKey: string };
type SslTxn = { valId: string; tran: string; amount: string; currency: string; bankTranId: string; risk: string; status: string };
type SslRefund = { ref: string; bank: string; amount: string; status: "processing" | "refunded" | "cancelled" };

type Fault = "timeout" | "http500" | "http401" | "garbage";

export class FakeProviderNet extends HttpClient {
  readonly calls: { method: string; url: string; query: Record<string, string>; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> }[] = [];
  bkash = new Map<string, BkashPayment>();
  ssl = new Map<string, SslSession>();
  sslTxns = new Map<string, SslTxn>();
  sslRefunds = new Map<string, SslRefund>();
  private faults = new Map<string, Fault[]>();
  private counter = 0;
  /** When set, the next bKash refund call is accepted but only completes after `completeBkashRefunds()`. */
  bkashRefundsComplete = true;
  sslRefundsComplete = true;

  reset() {
    this.calls.length = 0;
    this.bkash.clear();
    this.ssl.clear();
    this.sslTxns.clear();
    this.sslRefunds.clear();
    this.faults.clear();
    this.bkashRefundsComplete = true;
    this.sslRefundsComplete = true;
  }

  /** Make the next calls whose route key starts with `route` fail like a real network would. */
  fail(route: string, fault: Fault, times = 1) {
    this.faults.set(route, Array(times).fill(fault));
  }
  callsTo(fragment: string) {
    return this.calls.filter((c) => c.url.includes(fragment));
  }

  // ---- the customer's side of the world ----------------------------------

  /** The customer approves the payment inside bKash (OTP + PIN). */
  bkashApprove(paymentId: string, opts: { amount?: string } = {}) {
    const p = this.bkash.get(paymentId)!;
    p.approved = true;
    if (opts.amount) p.paidAmount = opts.amount;
  }
  /** The customer completes payment on the SSLCOMMERZ page. Returns the val_id the callback would carry. */
  sslPay(tran: string, opts: { amount?: string; currency?: string; risk?: string } = {}) {
    const s = [...this.ssl.values()].find((x) => x.tran === tran)!;
    const n = ++this.counter;
    const txn: SslTxn = {
      valId: `VAL${n}`,
      tran,
      amount: opts.amount ?? s.amount,
      currency: opts.currency ?? "BDT",
      bankTranId: `BANK${n}`,
      risk: opts.risk ?? "0",
      status: "VALID",
    };
    this.sslTxns.set(txn.valId, txn);
    return txn;
  }
  completeBkashRefund(refundTrxId: string) {
    for (const p of this.bkash.values()) for (const r of p.refunds) if (r.refundTrxId === refundTrxId) r.status = "Completed";
  }

  // ---- HttpClient ----------------------------------------------------------

  override async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const query = { ...Object.fromEntries(url.searchParams), ...req.query };
    this.calls.push({ method: req.method, url: `${url.origin}${url.pathname}`, query, form: req.form, json: req.json, headers: req.headers });
    const route = `${url.origin}${url.pathname}`;
    for (const [key, queue] of this.faults) {
      if (route.includes(key) && queue.length > 0) {
        const fault = queue.shift()!;
        if (fault === "timeout") throw new HttpUnreachableError("timeout");
        if (fault === "http500") return { status: 500, body: { error: "boom" } };
        if (fault === "http401") return { status: 401, body: { message: "unauthorized" } };
        return { status: 200, body: undefined };
      }
    }
    if (route.startsWith(BKASH_BASE)) return this.bkashRoute(route.slice(BKASH_BASE.length), req);
    if (route.startsWith(SSL_HOST)) return this.sslRoute(url.pathname, req, query);
    throw new Error(`FakeProviderNet: unexpected URL ${route}`);
  }

  private ok(body: unknown): HttpResponse {
    return { status: 200, body };
  }

  private bkashRoute(path: string, req: HttpRequest): HttpResponse {
    const body = (req.json ?? {}) as Record<string, string>;
    if (path === "/auth/grant-token") {
      if (req.headers?.username !== TEST_ENV.BKASH_USERNAME || (req.json as Record<string, string>).app_secret !== TEST_ENV.BKASH_APP_SECRET) {
        return this.ok({ statusCode: "9999", statusMessage: "invalid credentials" });
      }
      return this.ok({ statusCode: "0000", statusMessage: "ok", token_type: "Bearer", id_token: `tok-${++this.counter}`, refresh_token: "r", expires_in: 3600 });
    }
    if (!req.headers?.Authorization?.startsWith("Bearer tok-") || req.headers["X-APP-Key"] !== TEST_ENV.BKASH_APP_KEY) {
      return { status: 401, body: { message: "unauthorized" } };
    }
    if (path === "/payment/create") {
      const paymentId = `TR${++this.counter}`;
      this.bkash.set(paymentId, { paymentId, invoice: body.merchantInvoiceNumber!, amount: body.amount!, approved: false, executed: false, status: "Initiated", refunds: [] });
      return this.ok({
        paymentId, paymentCreateTime: "x", transactionStatus: "Initiated", amount: body.amount, currency: "BDT",
        intent: "sale", merchantInvoiceNumber: body.merchantInvoiceNumber, bKashURL: `https://sandbox.bka.sh/checkout/${paymentId}`,
        callbackURL: body.callbackURL, successCallbackURL: "x", failureCallbackURL: "x", cancelledCallbackURL: "x", signature: "sig",
      });
    }
    const p = this.bkash.get(body.paymentId!);
    if (path === "/payment/execute") {
      if (!p) return this.ok({ externalCode: "2002", internalCode: "invalid_payment_id", errorMessageEn: "Invalid Payment ID" });
      if (p.executed || !p.approved) {
        p.executed = true;
        return this.ok({ externalCode: "2062", internalCode: "x", errorMessageEn: "not executable" });
      }
      p.executed = true;
      p.status = "Completed";
      p.trxId = `TRX${++this.counter}`;
      return this.ok({ paymentId: p.paymentId, trxId: p.trxId, transactionStatus: "Completed", amount: p.paidAmount ?? p.amount, currency: "BDT", merchantInvoiceNumber: p.invoice });
    }
    if (path === "/query/payment") {
      if (!p) return this.ok({ externalCode: "2002", internalCode: "invalid_payment_id", errorMessageEn: "Invalid Payment ID" });
      return this.ok({
        paymentId: p.paymentId, transactionStatus: p.status, trxId: p.trxId, amount: p.paidAmount ?? p.amount, currency: "BDT",
        merchantInvoice: p.invoice, verificationStatus: p.status === "Completed" ? "Complete" : "Incomplete",
      });
    }
    if (path === "/refund/payment/transaction") {
      if (!p || p.trxId !== (req.json as Record<string, string>).trxId) return this.ok({ externalCode: "2006", errorMessageEn: "bad trx" });
      const refundTrxId = `RF${++this.counter}`;
      const amount = String((req.json as Record<string, unknown>).refundAmount);
      p.refunds.push({ refundTrxId, amount, status: this.bkashRefundsComplete ? "Completed" : "Initiated" });
      return this.ok({ originalTrxId: p.trxId, refundTrxId, refundTransactionStatus: this.bkashRefundsComplete ? "Completed" : "Initiated", refundAmount: amount, currency: "BDT" });
    }
    if (path === "/refund/payment/status") {
      if (!p) return this.ok({ externalCode: "3045", errorMessageEn: "x" });
      return this.ok({
        originalTrxId: p.trxId,
        refundTransactions: p.refunds.map((r) => ({ refundTrxId: r.refundTrxId, refundTransactionStatus: r.status === "Completed" ? "Completed" : "Initiated", refundAmount: r.amount })),
      });
    }
    return { status: 404, body: { message: "no route" } };
  }

  private sslRoute(path: string, req: HttpRequest, q: Record<string, string>): HttpResponse {
    if (path === "/gwprocess/v4/api.php") {
      const f = req.form ?? {};
      if (f.store_id !== TEST_ENV.SSLCOMMERZ_STORE_ID || f.store_passwd !== TEST_ENV.SSLCOMMERZ_STORE_PASSWORD) {
        return this.ok({ status: "FAILED", failedreason: "Store Credential Error" });
      }
      const sessionKey = `SESS${++this.counter}`;
      this.ssl.set(sessionKey, { tran: f.tran_id!, amount: f.total_amount!, sessionKey });
      return this.ok({ status: "SUCCESS", sessionkey: sessionKey, GatewayPageURL: `https://sandbox.sslcommerz.com/gwprocess/v4/gw.php?Q=${sessionKey}` });
    }
    if (q.store_id !== TEST_ENV.SSLCOMMERZ_STORE_ID || q.store_passwd !== TEST_ENV.SSLCOMMERZ_STORE_PASSWORD) {
      return this.ok({ APIConnect: "INVALID_REQUEST" });
    }
    if (path === "/validator/api/validationserverAPI.php") {
      const t = this.sslTxns.get(q.val_id ?? "");
      if (!t) return this.ok({ status: "INVALID_TRANSACTION", APIConnect: "DONE" });
      return this.ok({
        status: t.status, tran_id: t.tran, val_id: t.valId, amount: t.amount, store_amount: t.amount, currency: "BDT",
        currency_type: t.currency, currency_amount: t.amount, bank_tran_id: t.bankTranId, risk_level: t.risk, risk_title: "Safe", APIConnect: "DONE",
      });
    }
    if (path === "/validator/api/merchantTransIDvalidationAPI.php") {
      if (q.tran_id) {
        const found = [...this.sslTxns.values()].filter((t) => t.tran === q.tran_id);
        const sessions = [...this.ssl.values()].filter((s) => s.tran === q.tran_id);
        const element = found.length
          ? found.map((t) => ({ status: t.status, val_id: t.valId, tran_id: t.tran, amount: t.amount, bank_tran_id: t.bankTranId }))
          : sessions.map((s) => ({ status: "PENDING", val_id: "", tran_id: s.tran, amount: s.amount }));
        return this.ok({ APIConnect: "DONE", no_of_trans_found: element.length, element });
      }
      if (q.bank_tran_id) {
        const txn = [...this.sslTxns.values()].find((t) => t.bankTranId === q.bank_tran_id);
        if (!txn) return this.ok({ APIConnect: "DONE", status: "failed", errorReason: "bad bank_tran_id" });
        const ref = `SSLREF${++this.counter}`;
        this.sslRefunds.set(ref, { ref, bank: q.bank_tran_id, amount: q.refund_amount!, status: this.sslRefundsComplete ? "refunded" : "processing" });
        return this.ok({ APIConnect: "DONE", bank_tran_id: q.bank_tran_id, trans_id: txn.tran, refund_ref_id: ref, status: "success", errorReason: "" });
      }
      if (q.refund_ref_id) {
        const r = this.sslRefunds.get(q.refund_ref_id);
        if (!r) return this.ok({ APIConnect: "DONE", status: "cancelled", errorReason: "not found" });
        return this.ok({ APIConnect: "DONE", refund_ref_id: r.ref, bank_tran_id: r.bank, status: r.status });
      }
    }
    return { status: 404, body: undefined };
  }
}
