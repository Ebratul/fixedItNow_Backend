import type { Env } from "../../config/env.js";
import { formatDecimalBdt, parseDecimalToPoisha } from "../money.js";
import { HttpUnreachableError, type HttpClient, type HttpResponse } from "./http.js";
import {
  isRecord,
  safeCode,
  str,
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
 * SSLCOMMERZ hosted checkout (v4), written from the official page
 * https://developer.sslcommerz.com/doc/v4/ (session initiation, Order
 * Validation API, transaction query by tran_id, refund and refund-status APIs),
 * read on 2026-10-24.
 *
 * STATUS: implemented and unit-tested against MOCKED responses only. It has not
 * been run against the SSLCOMMERZ sandbox (no credentials).
 *
 * The browser POSTs to success/fail/cancel URLs and the IPN POSTs to ipn_url.
 * ALL of those payloads are untrusted. A transaction counts as paid only when
 * the Order Validation API (val_id) reports VALID/VALIDATED with a matching
 * tran_id, amount and currency.
 *
 * The IPN `verify_sign`/`verify_key` hash is NOT implemented: the official page
 * does not state the algorithm, and the page itself requires calling the
 * Validation API, which is what we do. We do not guess a hashing scheme.
 */

const HOSTS = { sandbox: "https://sandbox.sslcommerz.com", live: "https://securepay.sslcommerz.com" } as const;
const VALIDATOR = "/validator/api/validationserverAPI.php";
const TRANSACTION_API = "/validator/api/merchantTransIDvalidationAPI.php";

/** UNVERIFIED: these session fields are mandatory but FixedItNow does not collect them. */
const PLACEHOLDER = "N/A";

type Answer = { kind: "ok"; body: Record<string, unknown> } | { kind: "indeterminate"; code: string };

export class SslcommerzAdapter implements PaymentProviderAdapter {
  readonly id = "SSLCOMMERZ" as const;
  readonly label = "SSLCOMMERZ (cards, mobile banking, net banking)";
  readonly checkoutHostSuffixes = [".sslcommerz.com"] as const;
  /** From the session-initiation page: 10.00 to 500000.00 BDT. */
  readonly amountLimitsBdt = { min: 10, max: 500_000 };

  constructor(
    private readonly cfg: NonNullable<Env["sslcommerz"]>,
    private readonly http: HttpClient,
  ) {}

  get isLive() {
    return this.cfg.isLive;
  }
  get refundsEnabled() {
    return this.cfg.refundsEnabled;
  }
  private get host() {
    return this.cfg.isLive ? HOSTS.live : HOSTS.sandbox;
  }
  private get credentials() {
    return { store_id: this.cfg.storeId, store_passwd: this.cfg.storePassword };
  }

  private async get(path: string, query: Record<string, string>): Promise<Answer> {
    let res: HttpResponse;
    try {
      // The documented GET APIs take the store password in the query string. The
      // HTTP client never logs URLs and its errors carry none.
      res = await this.http.request({ method: "GET", url: `${this.host}${path}`, query: { ...query, ...this.credentials, format: "json" } });
    } catch (error) {
      return { kind: "indeterminate", code: error instanceof HttpUnreachableError ? error.reason.toUpperCase() : "NETWORK" };
    }
    if (res.status >= 500) return { kind: "indeterminate", code: `HTTP_${res.status}` };
    if (!isRecord(res.body)) return { kind: "indeterminate", code: "BAD_RESPONSE" };
    return { kind: "ok", body: res.body };
  }

  // ------------------------------------------------------------------ session

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    let res: HttpResponse;
    try {
      res = await this.http.request({
        method: "POST",
        url: `${this.host}/gwprocess/v4/api.php`,
        form: {
          ...this.credentials,
          total_amount: formatDecimalBdt(input.amountBdt),
          currency: "BDT",
          tran_id: input.reference,
          success_url: input.urls.success,
          fail_url: input.urls.fail,
          cancel_url: input.urls.cancel,
          ipn_url: input.urls.ipn,
          product_name: input.productName.slice(0, 100),
          product_category: "service",
          product_profile: "general",
          shipping_method: "NO",
          cus_name: input.customer.name.slice(0, 50) || PLACEHOLDER,
          cus_email: input.customer.email,
          cus_add1: PLACEHOLDER,
          cus_city: PLACEHOLDER,
          cus_postcode: PLACEHOLDER,
          cus_country: "Bangladesh",
          cus_phone: PLACEHOLDER,
        },
      });
    } catch (error) {
      return { kind: "unreachable", code: error instanceof HttpUnreachableError ? error.reason.toUpperCase() : "NETWORK" };
    }
    if (res.status >= 500 || !isRecord(res.body)) return { kind: "unreachable", code: res.status >= 500 ? `HTTP_${res.status}` : "BAD_RESPONSE" };
    const { body } = res;
    if (body.status !== "SUCCESS") return { kind: "rejected", code: "SESSION_FAILED" }; // failedreason is not stored: it may echo input
    const sessionKey = str(body.sessionkey);
    const checkoutUrl = str(body.GatewayPageURL);
    if (!sessionKey || !checkoutUrl) return { kind: "rejected", code: "BAD_RESPONSE" };
    return { kind: "ok", providerPaymentId: sessionKey, checkoutUrl };
  }

  // ------------------------------------------------------------------ verify

  async verify(ctx: VerifyContext): Promise<Verification> {
    let valId = ctx.providerValidationId;
    if (!valId) {
      // No val_id (lost callback / IPN): look the transaction up by OUR tran_id.
      const found = await this.lookupByReference(ctx.reference);
      if (found.kind !== "found") return found.verification;
      valId = found.valId;
    }
    return this.validate(valId);
  }

  private async lookupByReference(
    reference: string,
  ): Promise<{ kind: "found"; valId: string } | { kind: "none"; verification: Verification }> {
    const answer = await this.get(TRANSACTION_API, { tran_id: reference });
    if (answer.kind === "indeterminate") return { kind: "none", verification: answer };
    const { body } = answer;
    if (body.APIConnect !== "DONE") return { kind: "none", verification: { kind: "indeterminate", code: `API_${safeCode(body.APIConnect)}` } };
    const elements = Array.isArray(body.element) ? body.element.filter(isRecord) : [];
    if (elements.length === 0) return { kind: "none", verification: { kind: "not_completed", state: "unknown" } };
    const paid = elements.filter((e) => e.status === "VALID" || e.status === "VALIDATED");
    const valIds = [...new Set(paid.map((e) => str(e.val_id)).filter((v): v is string => v !== null))];
    if (valIds.length === 1) return { kind: "found", valId: valIds[0]! };
    // Two different successful sessions for one tran_id must not be guessed between.
    if (valIds.length > 1) return { kind: "none", verification: { kind: "indeterminate", code: "MULTIPLE_VALID_TRANSACTIONS" } };
    if (elements.some((e) => e.status === "PENDING")) return { kind: "none", verification: { kind: "not_completed", state: "pending" } };
    return { kind: "none", verification: { kind: "not_completed", state: "failed" } };
  }

  /** Order Validation API: the official proof that a transaction was paid. */
  async validate(valId: string): Promise<Verification> {
    const answer = await this.get(VALIDATOR, { val_id: valId });
    if (answer.kind === "indeterminate") return answer;
    const { body } = answer;
    if (body.status === "VALID" || body.status === "VALIDATED") {
      const bankTranId = str(body.bank_tran_id);
      if (!bankTranId) return { kind: "indeterminate", code: "MISSING_BANK_TRAN_ID" };
      // `amount` is settled in BDT; currency_type/currency_amount describe the order itself.
      // For a BDT order all of them must agree, otherwise no amount is reported (=> mismatch).
      const amount = parseDecimalToPoisha(body.amount);
      const orderAmount = body.currency_amount === undefined ? amount : parseDecimalToPoisha(body.currency_amount);
      const consistent = amount !== null && amount === orderAmount && (str(body.currency) ?? "BDT") === "BDT";
      return {
        kind: "completed",
        reference: str(body.tran_id),
        providerPaymentId: null,
        providerTransactionId: bankTranId,
        providerValidationId: str(body.val_id) ?? valId,
        amountPoisha: consistent ? amount : null,
        currency: str(body.currency_type) ?? str(body.currency),
        riskFlagged: String(body.risk_level) === "1",
      };
    }
    if (body.status === "INVALID_TRANSACTION") return { kind: "not_completed", state: "unknown" };
    return { kind: "indeterminate", code: `STATUS_${safeCode(body.status)}` };
  }

  // ------------------------------------------------------------------ refunds

  async refund(input: RefundInput): Promise<RefundResult> {
    const answer = await this.get(TRANSACTION_API, {
      bank_tran_id: input.providerTransactionId,
      refund_trans_id: input.refundReference,
      refund_amount: formatDecimalBdt(input.amountBdt),
      refund_remarks: input.reason.slice(0, 255),
      refe_id: input.paymentReference,
    });
    if (answer.kind === "indeterminate") return answer;
    const { body } = answer;
    if (body.APIConnect !== "DONE") return { kind: "rejected", code: `API_${safeCode(body.APIConnect)}` };
    if (body.status === "failed") return { kind: "rejected", code: "REFUND_FAILED" }; // errorReason is not stored
    const refId = str(body.refund_ref_id);
    // refund_ref_id is "returned only when the request is accepted".
    if ((body.status === "success" || body.status === "processing") && refId) return { kind: "accepted", providerRefundId: refId };
    return { kind: "indeterminate", code: "UNEXPECTED_REFUND_RESPONSE" };
  }

  async refundStatus(input: RefundStatusInput): Promise<RefundStatusResult> {
    if (!input.providerRefundId) return { kind: "indeterminate", code: "MISSING_REFUND_REF" };
    const answer = await this.get(TRANSACTION_API, { refund_ref_id: input.providerRefundId });
    if (answer.kind === "indeterminate") return answer;
    const { body } = answer;
    if (body.APIConnect !== "DONE") return { kind: "indeterminate", code: `API_${safeCode(body.APIConnect)}` };
    if (str(body.refund_ref_id) && str(body.refund_ref_id) !== input.providerRefundId) {
      return { kind: "indeterminate", code: "REFUND_REF_MISMATCH" };
    }
    if (body.status === "refunded") return { kind: "refunded", providerRefundId: input.providerRefundId, amountPoisha: null };
    if (body.status === "processing") return { kind: "processing" };
    if (body.status === "cancelled") return { kind: "failed", code: "REFUND_CANCELLED" };
    return { kind: "indeterminate", code: `STATUS_${safeCode(body.status)}` };
  }
}
