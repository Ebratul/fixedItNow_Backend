import type {
  InitiateInput,
  InitiateResult,
  PaymentProviderAdapter,
  RefundInput,
  RefundResult,
  RefundStatusInput,
  RefundStatusResult,
  VerifyContext,
  Verification,
} from "./payment-provider.js";

/**
 * The SIMULATED payment provider for demo accounts (docs/DEMO.md). It has no credentials, makes no network call and moves
 * no money. "Checkout" is a page of this web app; the customer's choice there (paid / failed / cancelled) is applied by
 * PaymentsService.simulateDemoOutcome through the same state machine and booking gate as a real payment, using values
 * read from the stored attempt, never from the request.
 *
 * It is reachable only inside the demo realm (PaymentProviders.get), and the database refuses a DEMO payment for an
 * ordinary customer (payment_realm_guard) and a real-provider payment for a demo customer.
 */
export class DemoPaymentAdapter implements PaymentProviderAdapter {
  readonly id = "DEMO" as const;
  readonly label = "Simulated payment (demo)";
  readonly isLive = false;
  /** A simulated payment can be refunded in no way but on paper: nothing is ever sent anywhere. */
  readonly refundsEnabled = false;
  readonly amountLimitsBdt = { min: 1, max: 500_000 };
  /** Not used: the checkout URL is this web app's own page (the caller skips the provider host allow-list for it). */
  readonly checkoutHostSuffixes: readonly string[] = [];

  constructor(private readonly frontendOrigin: string) {}

  initiate(input: InitiateInput): Promise<InitiateResult> {
    return Promise.resolve({
      kind: "ok",
      providerPaymentId: `demo_${input.reference}`,
      checkoutUrl: `${this.frontendOrigin}/payments/demo/${input.reference}`,
    });
  }

  /** Nothing outside the app can know about a simulated payment, so a status lookup never finds a payment. */
  verify(_ctx: VerifyContext): Promise<Verification> {
    return Promise.resolve({ kind: "not_completed", state: "pending" });
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.resolve({ kind: "rejected", code: "DEMO_SIMULATED" });
  }

  refundStatus(_input: RefundStatusInput): Promise<RefundStatusResult> {
    return Promise.resolve({ kind: "failed", code: "DEMO_SIMULATED" });
  }
}
