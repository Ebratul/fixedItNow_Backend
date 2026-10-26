import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../../config/env.js";
import { currentRealm } from "../../common/request-context.js";
import { BkashAdapter } from "./bkash.adapter.js";
import { DemoPaymentAdapter } from "./demo.adapter.js";
import { HttpClient } from "./http.js";
import type { PaymentProviderAdapter } from "./payment-provider.js";
import type { PaymentProvider } from "../../generated/prisma/client.js";

/**
 * The providers that are actually configured. An unconfigured provider does not exist here.
 *
 * Which provider a request may reach depends on its data realm (docs/DEMO.md): a demo session can only ever reach the
 * simulated provider, and an ordinary request can never reach it. So even a bug elsewhere cannot send a demo action to
 * bKash, or let a real booking be "paid" by a simulation.
 */
@Injectable()
export class PaymentProviders {
  private readonly adapters = new Map<PaymentProvider, PaymentProviderAdapter>();

  constructor(@Inject(ENV) env: Env, http: HttpClient) {
    if (env.bkash) this.adapters.set("BKASH", new BkashAdapter(env.bkash, http));
    this.adapters.set("DEMO", new DemoPaymentAdapter(env.frontendOrigin));
  }

  /** Takes the stored enum: a historical SSLCOMMERZ row simply has no adapter any more. */
  get(id: PaymentProvider): PaymentProviderAdapter | undefined {
    if ((id === "DEMO") !== (currentRealm() === "demo")) return undefined;
    return this.adapters.get(id);
  }

  /** Public description for the checkout UI. Contains no credentials. */
  describe() {
    if (currentRealm() === "demo") {
      const demo = this.adapters.get("DEMO")!;
      return [{ provider: "DEMO" as const, label: demo.label, available: true, mode: "simulated" as const, minAmountBdt: demo.amountLimitsBdt.min, maxAmountBdt: demo.amountLimitsBdt.max }];
    }
    return (["BKASH"] as const).map((id) => {
      const adapter = this.adapters.get(id);
      return {
        provider: id,
        label: "bKash",
        available: Boolean(adapter),
        mode: adapter ? (adapter.isLive ? "live" : "sandbox") : null,
        minAmountBdt: adapter?.amountLimitsBdt.min ?? null,
        maxAmountBdt: adapter?.amountLimitsBdt.max ?? null,
      };
    });
  }
}
