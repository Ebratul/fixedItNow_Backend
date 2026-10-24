import { Injectable, Logger } from "@nestjs/common";
import type { Payment } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PAID_PAYMENT_STATUSES } from "./payment.config.js";
import { recordEvent, SYSTEM } from "./payment.db.js";
import { PaymentsService } from "./payments.service.js";
import { safeCode, str, type PaymentProviderAdapter, type Verification } from "./providers/payment-provider.js";
import { PaymentProviders } from "./providers/providers.service.js";

export const REFERENCE_PATTERN = /^FIN[0-9A-F]{24}$/;
export type SslKind = "success" | "fail" | "cancel" | "ipn";

/**
 * Handles what providers (and customers' browsers) send to our public callback
 * endpoints. EVERYTHING here is untrusted input: the payment is looked up by OUR
 * reference, the claimed status is only a hint, and state changes only come from
 * the provider's own server-to-server verification (PaymentsService.applyVerification).
 *
 * Each method returns the stored payment reference (from the database, never
 * echoed from the request) or null when no such payment exists.
 */
@Injectable()
export class PaymentCallbacksService {
  private readonly log = new Logger("PaymentCallbacks");

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly providers: PaymentProviders,
  ) {}

  private async find(reference: string, provider: "BKASH" | "SSLCOMMERZ"): Promise<Payment | null> {
    if (!REFERENCE_PATTERN.test(reference)) return null;
    return this.prisma.payment.findFirst({ where: { reference, provider } });
  }

  private ctx(p: Payment, validationId: string | null = p.providerValidationId) {
    return { reference: p.reference, providerPaymentId: p.providerPaymentId, providerValidationId: validationId, amountBdt: p.amountBdt };
  }

  private async safely(label: string, work: () => Promise<Verification>): Promise<Verification> {
    try {
      return await work();
    } catch (error) {
      this.log.warn(`${label}: ${(error as Error | undefined)?.name ?? "error"}`); // never the message: it may carry request data
      return { kind: "indeterminate", code: "ADAPTER_ERROR" };
    }
  }

  private isSettled(p: Payment) {
    return PAID_PAYMENT_STATUSES.includes(p.status) || p.status === "REQUIRES_REVIEW";
  }

  // ================================================================ bKash

  /**
   * GET <callbackURL>?paymentID=...&status=success|failure|cancel[&signature=...]
   * `status` and `signature` are NOT trusted (the docs give no way to verify the
   * signature). The payment is confirmed by EXECUTE + QUERY PAYMENT.
   */
  async bkash(reference: string, query: Record<string, unknown>): Promise<string | null> {
    const p = await this.find(reference, "BKASH");
    if (!p) return null;
    const adapter = this.providers.get("BKASH");
    const claimedRaw = str(query.status);
    const claimed = claimedRaw === "success" || claimedRaw === "failure" || claimedRaw === "cancel" ? claimedRaw : "unknown";
    const paymentId = str(query.paymentID) ?? str(query.paymentId);
    const matches = paymentId !== null && paymentId === p.providerPaymentId;

    await this.recordCallback(p, `cb:${p.id}:${claimed}:${matches}`, { provider: "BKASH", claimed, paymentIdMatches: matches });
    if (!matches) {
      // A callback naming a different bKash payment must not touch this attempt.
      await this.recordCallback(p, `cbrej:${p.id}:${paymentId ? "other" : "none"}`, { rejected: "PAYMENT_ID_MISMATCH" }, "payment.callback_rejected");
      return p.reference;
    }
    if (this.isSettled(p) || !adapter) return p.reference;

    if (claimed === "success") {
      await this.payments.markCallbackReceived(p.id, SYSTEM, "bkash_callback");
      if (await this.payments.claimExecute(p.id)) {
        let result;
        try {
          result = await adapter.completeAfterApproval!(this.ctx(p));
        } catch {
          result = { verification: { kind: "indeterminate", code: "ADAPTER_ERROR" } as Verification, executed: true };
        }
        // Execute never reached bKash (e.g. no token): let a later callback/reconcile retry it.
        if (!result.executed) await this.payments.releaseExecute(p.id);
        await this.payments.applyVerification(p.id, result.verification, { actor: SYSTEM, source: "bkash_callback", executed: result.executed });
      } else {
        // Another request owns the single execute call: just ask bKash what happened.
        await this.verifyAndApply(p, adapter, "bkash_callback");
      }
      return p.reference;
    }

    await this.verifyAndApply(p, adapter, "bkash_callback", claimed === "cancel" ? "cancelled" : claimed === "failure" ? "failed" : undefined);
    return p.reference;
  }

  // ================================================================ SSLCOMMERZ

  /** Browser POST (success/fail/cancel) or server-to-server IPN. All fields are untrusted. */
  async sslcommerz(kind: SslKind, form: Record<string, unknown>): Promise<string | null> {
    const tranId = str(form.tran_id);
    const p = tranId ? await this.find(tranId, "SSLCOMMERZ") : null;
    if (!p) return null;
    const adapter = this.providers.get("SSLCOMMERZ");

    const claimedStatus = safeCode(form.status, "NONE");
    const claim = this.sslClaim(kind, claimedStatus);
    await this.recordCallback(p, `cb:${p.id}:${kind}:${claimedStatus}`, { provider: "SSLCOMMERZ", kind, claimedStatus });
    if (this.isSettled(p) || !adapter) return p.reference;

    if (claim === null) await this.payments.markCallbackReceived(p.id, SYSTEM, `sslcommerz_${kind}`);
    const valId = str(form.val_id);

    let v = await this.safely("ssl.verify", () => adapter.verify(this.ctx(p, valId ?? p.providerValidationId)));
    const foreign = v.kind === "completed" && v.reference !== p.reference;
    if (valId && (foreign || v.kind === "not_completed")) {
      // The val_id in the request belongs to another transaction or is unknown: do not
      // trust it. Fall back to looking the transaction up by OUR tran_id.
      if (foreign) {
        await this.recordCallback(p, `cbrej:${p.id}:foreign_val`, { rejected: "FOREIGN_VALIDATION_ID" }, "payment.callback_rejected");
      }
      v = await this.safely("ssl.lookup", () => adapter.verify(this.ctx(p, null)));
    }
    if (v.kind === "indeterminate") {
      await this.payments.markCallbackReceived(p.id, SYSTEM, `sslcommerz_${kind}`);
      return p.reference; // stays PROCESSING; reconciliation resolves it
    }
    await this.payments.applyVerification(p.id, v, { actor: SYSTEM, source: `sslcommerz_${kind}`, claim: claim ?? undefined });
    return p.reference;
  }

  private sslClaim(kind: SslKind, status: string): "failed" | "cancelled" | null {
    if (kind === "fail") return "failed";
    if (kind === "cancel") return "cancelled";
    if (kind === "ipn") {
      if (status === "CANCELLED") return "cancelled";
      if (status === "FAILED" || status === "EXPIRED" || status === "UNATTEMPTED") return "failed";
    }
    return null; // success (or an IPN that claims success): the Validation API decides
  }

  // ================================================================ shared

  private async verifyAndApply(p: Payment, adapter: PaymentProviderAdapter, source: string, claim?: "failed" | "cancelled") {
    const v = await this.safely(`${p.provider}.verify`, () => adapter.verify(this.ctx(p)));
    if (v.kind === "indeterminate") {
      await this.payments.markCallbackReceived(p.id, SYSTEM, source);
      return;
    }
    await this.payments.applyVerification(p.id, v, { actor: SYSTEM, source, claim: v.kind === "completed" ? undefined : claim });
  }

  /** Callback audit rows are deduplicated, so a retried callback adds nothing. */
  private async recordCallback(p: Payment, dedupeKey: string, metadata: Record<string, string | boolean>, type = "payment.callback_received") {
    await this.prisma.$transaction((tx) => recordEvent(tx, p.id, SYSTEM, { type, dedupeKey, metadata }));
  }
}
