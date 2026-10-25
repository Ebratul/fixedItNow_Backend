import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../../config/env.js";
import { BkashAdapter } from "./bkash.adapter.js";
import { HttpClient } from "./http.js";
import type { PaymentProviderAdapter } from "./payment-provider.js";
import type { PaymentProvider } from "../../generated/prisma/client.js";

/** The providers that are actually configured. An unconfigured provider does not exist here. */
@Injectable()
export class PaymentProviders {
  private readonly adapters = new Map<PaymentProvider, PaymentProviderAdapter>();

  constructor(@Inject(ENV) env: Env, http: HttpClient) {
    if (env.bkash) this.adapters.set("BKASH", new BkashAdapter(env.bkash, http));
  }

  /** Takes the stored enum: a historical SSLCOMMERZ row simply has no adapter any more. */
  get(id: PaymentProvider): PaymentProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Public description for the checkout UI. Contains no credentials. */
  describe() {
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
