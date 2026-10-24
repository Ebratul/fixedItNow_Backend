import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../../config/env.js";
import { BkashAdapter } from "./bkash.adapter.js";
import { HttpClient } from "./http.js";
import type { PaymentProviderAdapter, ProviderId } from "./payment-provider.js";
import { SslcommerzAdapter } from "./sslcommerz.adapter.js";

/** The providers that are actually configured. An unconfigured provider does not exist here. */
@Injectable()
export class PaymentProviders {
  private readonly adapters = new Map<ProviderId, PaymentProviderAdapter>();

  constructor(@Inject(ENV) env: Env, http: HttpClient) {
    if (env.bkash) this.adapters.set("BKASH", new BkashAdapter(env.bkash, http));
    if (env.sslcommerz) this.adapters.set("SSLCOMMERZ", new SslcommerzAdapter(env.sslcommerz, http));
  }

  get(id: ProviderId): PaymentProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Public description for the checkout UI. Contains no credentials. */
  describe() {
    return (["BKASH", "SSLCOMMERZ"] as const).map((id) => {
      const adapter = this.adapters.get(id);
      return {
        provider: id,
        label: id === "BKASH" ? "bKash" : "SSLCOMMERZ",
        available: Boolean(adapter),
        mode: adapter ? (adapter.isLive ? "live" : "sandbox") : null,
        minAmountBdt: adapter?.amountLimitsBdt.min ?? null,
        maxAmountBdt: adapter?.amountLimitsBdt.max ?? null,
      };
    });
  }
}
