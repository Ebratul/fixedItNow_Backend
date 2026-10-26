import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  type PipeTransform,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { IDEMPOTENCY_KEY, demoOutcomeSchema, initiatePaymentSchema, listPaymentsSchema, refundRequestSchema, type DemoOutcomeInput, type InitiatePaymentInput } from "./payment.schemas.js";
import { REFERENCE_PATTERN } from "./payment-callbacks.service.js";
import { PaymentsService } from "./payments.service.js";
import { RefundsService } from "./refunds.service.js";

/** Same 404 for a malformed and an unknown reference. */
export class ReferencePipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!REFERENCE_PATTERN.test(value)) throw new NotFoundException("Payment not found");
    return value;
  }
}

export function checkKey(key: string | undefined) {
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException("Idempotency-Key must be 8-64 letters, digits, '-' or '_'");
  }
  return key;
}

/**
 * Customer payment endpoints. Every route requires a session (global default
 * deny); a payment or booking that is not yours is the same 404 as a missing one.
 */
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Post("bookings/:id/payments")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async initiate(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) bookingId: string,
    @Body(new ZodPipe(initiatePaymentSchema)) body: InitiatePaymentInput,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, ...result } = await this.payments.initiate(auth, bookingId, body.provider, checkKey(key));
    res.status(created ? 201 : 200);
    return result;
  }

  // Literal path first: it must not be read as a :reference.
  @Get("payments/providers")
  providers() {
    return this.payments.listProviders();
  }

  @Get("payments")
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listPaymentsSchema)) q: { page: number; pageSize: number }) {
    return this.payments.listForCustomer(auth, q.page, q.pageSize);
  }

  @Get("payments/:reference")
  detail(@CurrentAuth() auth: AuthContext, @Param("reference", new ReferencePipe()) reference: string) {
    return this.payments.getForCustomer(auth, reference);
  }

  /** Simulated checkout for demo accounts. Everyone else gets the same 404 as for a payment that does not exist. */
  @Post("payments/:reference/demo-outcome")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  demoOutcome(
    @CurrentAuth() auth: AuthContext,
    @Param("reference", new ReferencePipe()) reference: string,
    @Body(new ZodPipe(demoOutcomeSchema)) body: DemoOutcomeInput,
  ) {
    return this.payments.simulateDemoOutcome(auth, reference, body.outcome);
  }

  @Post("payments/:reference/refunds")
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestRefund(
    @CurrentAuth() auth: AuthContext,
    @Param("reference", new ReferencePipe()) reference: string,
    @Body(new ZodPipe(refundRequestSchema)) body: { amountBdt?: number; reason: string },
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.refunds.request(auth, reference, body, checkKey(key));
  }
}
