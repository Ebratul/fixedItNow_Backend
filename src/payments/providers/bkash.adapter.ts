import type { Env } from "../../config/env.js";
import { formatDecimalBdt, parseDecimalToPoisha } from "../money.js";
import { HttpUnreachableError, type HttpClient } from "./http.js";
import {
  isRecord,
  safeCode,
  str,
  type ApprovalResult,
  type InitiateInput,
  type InitiateResult,
  type PaymentProviderAdapter,
  type RefundInput,
  type RefundResult,
  type RefundStatusInput,
  type RefundStatusResult,
  type Verification,
  type VerifyContext,
} from "./payment-provider.js";

/**
 * bKash Tokenized Checkout v2 (without agreement), written from the official
 * pages under https://developer.bka.sh/docs (grant-token, create-payment-3,
 * execute-payment-4, query-payment, refund, refund-status), read on 2026-10-24.
 *
 * STATUS: implemented and unit-tested against MOCKED responses only. It has not
 * been run against the bKash sandbox (no credentials). Details the docs leave
 * unclear are marked UNVERIFIED below and in docs/PAYMENTS.md.
 *
 * Flow: grant token -> create payment -> customer pays on bKash -> bKash
 * redirects the browser to our callback (status is UNTRUSTED) -> we call
 * EXECUTE once -> we confirm with QUERY PAYMENT -> only a Completed query result
 * with matching reference/amount/currency counts as payment.
 */

const TOKEN_REFRESH_MARGIN_MS = 120_000;
/** Grant-token is limited to 2 calls/hour (docs); after a failure do not hammer it. */
const TOKEN_FAILURE_COOLDOWN_MS = 5 * 60_000;

type Call =
  | { kind: "ok"; body: Record<string, unknown> }
  /** bKash answered with an error (externalCode / statusCode != 0000). */
  | { kind: "error"; code: string }
  /** Nothing usable. `sent` = the request may have reached bKash. */
  | { kind: "indeterminate"; code: string; sent: boolean };

export class BkashAdapter implements PaymentProviderAdapter {
  readonly id = "BKASH" as const;
  readonly label = "bKash";
  readonly checkoutHostSuffixes = [".bka.sh"] as const;
  /** The bKash pages read document no amount limit; real limits come from the merchant agreement. This is the largest booking the platform can create. */
  readonly amountLimitsBdt = { min: 1, max: 3_000_000 };

  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<{ value: string } | { code: string }> | null = null;
  private tokenCooldownUntil = 0;

  constructor(
    private readonly cfg: NonNullable<Env["bkash"]>,
    private readonly http: HttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  get isLive() {
    return this.cfg.isLive;
  }
  get refundsEnabled() {
    return this.cfg.refundsEnabled;
  }

  // ------------------------------------------------------------------ token

  private async getToken(): Promise<{ value: string } | { code: string }> {
    if (this.token && this.token.expiresAt > this.now()) return { value: this.token.value };
    if (this.now() < this.tokenCooldownUntil) return { code: "TOKEN_UNAVAILABLE" };
    // Single flight: concurrent requests share one grant (it is rate limited).
    this.tokenInFlight ??= this.grant().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async grant(): Promise<{ value: string } | { code: string }> {
    try {
      const res = await this.http.request({
        method: "POST",
        url: `${this.cfg.baseUrl}/auth/grant-token`,
        headers: { username: this.cfg.username, password: this.cfg.password },
        json: { app_key: this.cfg.appKey, app_secret: this.cfg.appSecret },
      });
      const body = isRecord(res.body) ? res.body : {};
      const idToken = str(body.id_token);
      const status = body.statusCode === undefined ? "0000" : safeCode(body.statusCode);
      if (res.status >= 200 && res.status < 300 && idToken && status === "0000") {
        const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
        // The token is held in memory only: never logged, stored or returned.
        this.token = { value: idToken, expiresAt: this.now() + Math.max(seconds * 1000 - TOKEN_REFRESH_MARGIN_MS, 0) };
        return { value: idToken };
      }
      this.tokenCooldownUntil = this.now() + TOKEN_FAILURE_COOLDOWN_MS;
      return { code: `TOKEN_${safeCode(body.statusCode ?? body.externalCode ?? res.status)}` };
    } catch (error) {
      this.tokenCooldownUntil = this.now() + TOKEN_FAILURE_COOLDOWN_MS;
      return { code: error instanceof HttpUnreachableError ? "TOKEN_UNREACHABLE" : "TOKEN_ERROR" };
    }
  }

  private async call(path: string, json: Record<string, unknown>): Promise<Call> {
    const token = await this.getToken();
    if ("code" in token) return { kind: "indeterminate", code: "TOKEN_UNAVAILABLE", sent: false };
    let res;
    try {
      res = await this.http.request({
        method: "POST",
        url: `${this.cfg.baseUrl}${path}`,
        headers: {
          // UNVERIFIED: the docs table says "Bearer <id_token>", the curl samples send the raw id_token.
          Authorization: this.cfg.authScheme === "bearer" ? `Bearer ${token.value}` : token.value,
          "X-APP-Key": this.cfg.appKey,
        },
        json,
      });
    } catch (error) {
      return { kind: "indeterminate", code: error instanceof HttpUnreachableError ? error.reason.toUpperCase() : "NETWORK", sent: true };
    }
    if (res.status === 401 || res.status === 403) {
      this.token = null; // the next call grants a fresh token (subject to the cooldown/rate limit)
      return { kind: "indeterminate", code: "AUTH_ERROR", sent: false };
    }
    if (res.status >= 500 || !isRecord(res.body)) {
      return { kind: "indeterminate", code: res.status >= 500 ? `HTTP_${res.status}` : "BAD_RESPONSE", sent: true };
    }
    const body = res.body;
    if (body.externalCode !== undefined) return { kind: "error", code: safeCode(body.externalCode) };
    if (body.statusCode !== undefined && safeCode(body.statusCode) !== "0000") {
      return { kind: "error", code: safeCode(body.statusCode) };
    }
    if (res.status >= 400) return { kind: "error", code: `HTTP_${res.status}` };
    return { kind: "ok", body };
  }

  // ------------------------------------------------------------------ create

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const result = await this.call("/payment/create", {
      payerReference: input.reference,
      callbackURL: input.urls.callback,
      amount: formatDecimalBdt(input.amountBdt),
      currency: "BDT",
      intent: "sale",
      merchantInvoiceNumber: input.reference,
    });
    if (result.kind === "indeterminate") return { kind: "unreachable", code: result.code };
    if (result.kind === "error") return { kind: "rejected", code: result.code };
    const { body } = result;
    const paymentId = str(body.paymentId ?? body.paymentID);
    const checkoutUrl = str(body.bKashURL ?? body.bkashURL);
    if (!paymentId || !checkoutUrl) return { kind: "rejected", code: "BAD_RESPONSE" };
    // The echo must match what we asked for.
    const echoedInvoice = str(body.merchantInvoiceNumber);
    const echoedAmount = body.amount === undefined ? null : parseDecimalToPoisha(body.amount);
    if ((echoedInvoice && echoedInvoice !== input.reference) || (echoedAmount !== null && echoedAmount !== input.amountBdt * 100)) {
      return { kind: "rejected", code: "ECHO_MISMATCH" };
    }
    return { kind: "ok", providerPaymentId: paymentId, checkoutUrl };
  }

  // ------------------------------------------------------------------ verify

  async verify(ctx: VerifyContext): Promise<Verification> {
    if (!ctx.providerPaymentId) return { kind: "not_completed", state: "unknown" };
    const result = await this.call("/query/payment", { paymentId: ctx.providerPaymentId });
    if (result.kind === "indeterminate") return { kind: "indeterminate", code: result.code };
    // 2002 = "invalid payment ID" in the docs' sample: bKash does not know this payment.
    if (result.kind === "error") {
      return result.code === "2002" ? { kind: "not_completed", state: "unknown" } : { kind: "indeterminate", code: `BKASH_${result.code}` };
    }
    const { body } = result;
    const reportedPaymentId = str(body.paymentId ?? body.paymentID);
    if (reportedPaymentId && reportedPaymentId !== ctx.providerPaymentId) {
      return { kind: "indeterminate", code: "PAYMENT_ID_MISMATCH" };
    }
    const status = typeof body.transactionStatus === "string" ? body.transactionStatus : "";
    if (status === "Completed") {
      const trxId = str(body.trxId ?? body.trxID);
      if (!trxId) return { kind: "indeterminate", code: "MISSING_TRX_ID" };
      // verificationStatus "Incomplete" = the payer has not finished verification.
      if (body.verificationStatus === "Incomplete") return { kind: "not_completed", state: "pending" };
      return {
        kind: "completed",
        reference: str(body.merchantInvoiceNumber ?? body.merchantInvoice),
        providerPaymentId: reportedPaymentId ?? ctx.providerPaymentId,
        providerTransactionId: trxId,
        providerValidationId: null,
        amountPoisha: parseDecimalToPoisha(body.amount),
        currency: str(body.currency),
        riskFlagged: false,
      };
    }
    // Per the docs "Initiated" covers a payment that is still open AND one that was
    // cancelled or failed verification, so it can only ever mean "not completed yet".
    if (status === "Initiated") return { kind: "not_completed", state: "pending" };
    return { kind: "indeterminate", code: "UNEXPECTED_STATUS" };
  }

  /**
   * EXECUTE (once per paymentId; the docs forbid reuse after any attempt), then
   * independently confirm with QUERY. The execute response alone is never trusted.
   */
  async completeAfterApproval(ctx: VerifyContext): Promise<ApprovalResult> {
    if (!ctx.providerPaymentId) return { verification: { kind: "not_completed", state: "unknown" }, executed: false };
    const exec = await this.call("/payment/execute", { paymentId: ctx.providerPaymentId });
    const executed = !(exec.kind === "indeterminate" && !exec.sent);
    // Timeout or error response: ask bKash what really happened (docs: query after a timeout).
    return { verification: await this.verify(ctx), executed };
  }

  // ------------------------------------------------------------------ refunds

  async refund(input: RefundInput): Promise<RefundResult> {
    const result = await this.call("/refund/payment/transaction", {
      paymentId: input.providerPaymentId,
      trxId: input.providerTransactionId,
      refundAmount: formatDecimalBdt(input.amountBdt),
      sku: "service-booking",
      reason: input.reason.slice(0, 255),
    });
    if (result.kind === "indeterminate") return { kind: "indeterminate", code: result.code };
    if (result.kind === "error") return { kind: "rejected", code: result.code };
    const refundTrxId = str(result.body.refundTrxId ?? result.body.refundTrxID);
    if (!refundTrxId) return { kind: "indeterminate", code: "MISSING_REFUND_ID" };
    return { kind: "accepted", providerRefundId: refundTrxId };
  }

  async refundStatus(input: RefundStatusInput): Promise<RefundStatusResult> {
    if (!input.providerPaymentId) return { kind: "indeterminate", code: "MISSING_PAYMENT_ID" };
    // UNVERIFIED: the refund-status page describes `trxId` as the refund request id; the
    // refund page uses the ORIGINAL transaction id. We send the original id.
    const result = await this.call("/refund/payment/status", {
      paymentId: input.providerPaymentId,
      trxId: input.providerTransactionId,
    });
    if (result.kind === "indeterminate") return { kind: "indeterminate", code: result.code };
    if (result.kind === "error") return { kind: "indeterminate", code: `BKASH_${result.code}` };
    const list = Array.isArray(result.body.refundTransactions) ? result.body.refundTransactions.filter(isRecord) : [];
    const wanted = input.amountBdt * 100;
    const match = list.find((entry) =>
      input.providerRefundId
        ? str(entry.refundTrxId ?? entry.refundTrxID) === input.providerRefundId
        : parseDecimalToPoisha(entry.refundAmount) === wanted,
    );
    if (!match) return { kind: "indeterminate", code: "REFUND_NOT_LISTED" };
    const amountPoisha = parseDecimalToPoisha(match.refundAmount);
    if (match.refundTransactionStatus === "Completed") {
      return { kind: "refunded", providerRefundId: str(match.refundTrxId ?? match.refundTrxID), amountPoisha };
    }
    return { kind: "processing" };
  }
}
