import { Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Query, Res, Body } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public, SkipOriginCheck } from "../auth/decorators.js";
import { Inject } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { PaymentCallbacksService, type SslKind } from "./payment-callbacks.service.js";
import { PaymentsService } from "./payments.service.js";

const SSL_BROWSER_KINDS = new Set(["success", "fail", "cancel"]);

/**
 * PUBLIC endpoints called by payment providers and by customers' browsers
 * returning from a provider. No session, no CSRF Origin check (they are
 * cross-site by nature), so EVERY field is untrusted: nothing here changes a
 * payment's state from what the request claims. See PaymentCallbacksService.
 *
 * Responses never contain provider data or error details. The browser routes
 * always end in a redirect to a fixed page of OUR web app (no user-controlled
 * redirect target); that page asks the backend for the real status.
 */
@Public()
@SkipOriginCheck()
@Controller("payments")
export class PaymentCallbacksController {
  private readonly log = new Logger("PaymentCallbacks");

  constructor(
    private readonly callbacks: PaymentCallbacksService,
    private readonly payments: PaymentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private land(res: Response, reference: string | null) {
    const target = reference ? this.payments.returnUrl(reference) : `${this.env.frontendOrigin}/payments`;
    res.redirect(303, target);
  }

  private async safely(work: () => Promise<string | null>): Promise<string | null> {
    try {
      return await work();
    } catch (error) {
      // Name only: messages from the database layer can contain query text.
      this.log.error(`callback failed: ${(error as Error | undefined)?.name ?? "error"}`);
      return null;
    }
  }

  /** bKash redirects the customer's browser here: GET <callbackURL>?paymentID=&status=&signature= */
  @Get("callbacks/bkash/:reference")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async bkash(@Param("reference") reference: string, @Query() query: Record<string, unknown>, @Res() res: Response) {
    this.land(res, await this.safely(() => this.callbacks.bkash(reference, query ?? {})));
  }

  /** SSLCOMMERZ posts the customer's browser here after the hosted page. */
  @Post("callbacks/sslcommerz/:kind")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async sslcommerzBrowser(@Param("kind") kind: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    if (!SSL_BROWSER_KINDS.has(kind)) throw new NotFoundException();
    this.land(res, await this.safely(() => this.callbacks.sslcommerz(kind as SslKind, body ?? {})));
  }

  /**
   * SSLCOMMERZ IPN (server to server). The reply is the same plain "OK" whether
   * or not the notification matched anything, so it reveals nothing. Transient
   * failures answer 500 so the provider retries.
   */
  @Post("ipn/sslcommerz")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async sslcommerzIpn(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      await this.callbacks.sslcommerz("ipn", body ?? {});
      res.status(200).type("text/plain").send("OK");
    } catch (error) {
      this.log.error(`ipn failed: ${(error as Error | undefined)?.name ?? "error"}`);
      res.status(500).type("text/plain").send("ERROR");
    }
  }
}
