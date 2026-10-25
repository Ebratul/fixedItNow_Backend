import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Headers } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { emptyBodySchema } from "../bookings/booking.schemas.js";
import type { RefundStatus } from "../generated/prisma/client.js";
import { type AdminPaymentsQuery, approveRefundSchema, confirmedRefundRequestSchema, confirmSchema, adminPaymentsQuerySchema, adminRefundsQuerySchema, rejectRefundSchema } from "./payment.schemas.js";
import { checkKey, ReferencePipe } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { RefundsService } from "./refunds.service.js";

/**
 * Admin-only (permissions are read from the database on every request).
 * Admins cannot act on payments for bookings they take part in. Every mutation
 * writes an audit_log row; provider lookups are rate limited.
 */
@RequirePermission("payments.read")
@Controller("admin")
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Get("payments")
  list(@Query(new ZodPipe(adminPaymentsQuerySchema)) q: AdminPaymentsQuery) {
    return this.payments.adminList(q);
  }

  @RequirePermission("payments.reconcile")
  @Post("payments/reconcile-stale")
  @HttpCode(200)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  reconcileStale(@CurrentAuth() a: AuthContext, @Body(new ZodPipe(emptyBodySchema)) _b: unknown) {
    return this.payments.reconcileStale({ userId: a.userId, role: "ADMIN" });
  }

  @Get("payments/:reference")
  get(@Param("reference", new ReferencePipe()) reference: string) {
    return this.payments.adminDetail(reference);
  }

  @RequirePermission("payments.reconcile")
  @Post("payments/:reference/reconcile")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reconcile(@CurrentAuth() a: AuthContext, @Param("reference", new ReferencePipe()) reference: string, @Body(new ZodPipe(emptyBodySchema)) _b: unknown) {
    return this.payments.adminReconcile(a, reference);
  }

  @RequirePermission("refunds.decide")
  @Post("payments/:reference/refunds")
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createRefund(
    @CurrentAuth() a: AuthContext,
    @Param("reference", new ReferencePipe()) reference: string,
    @Body(new ZodPipe(confirmedRefundRequestSchema)) body: { amountBdt?: number; reason: string; confirm: true },
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.refunds.adminCreate(a, reference, { amountBdt: body.amountBdt, reason: body.reason }, checkKey(key));
  }

  @Get("refunds")
  listRefunds(@Query(new ZodPipe(adminRefundsQuerySchema)) q: { status?: RefundStatus; page: number; pageSize: number }) {
    return this.refunds.adminList(q.status, q.page, q.pageSize);
  }

  @Get("refunds/:id")
  getRefund(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.refunds.adminDetail(id);
  }

  @RequirePermission("refunds.decide")
  @Post("refunds/:id/approve")
  @HttpCode(200)
  approve(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(approveRefundSchema)) b: { amountBdt?: number; note?: string; confirm: true }) {
    return this.refunds.approve(a, id, { amountBdt: b.amountBdt, note: b.note });
  }

  @RequirePermission("refunds.decide")
  @Post("refunds/:id/reject")
  @HttpCode(200)
  reject(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(rejectRefundSchema)) b: { note: string }) {
    return this.refunds.reject(a, id, b.note);
  }

  @RequirePermission("refunds.process")
  @Post("refunds/:id/process")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  process(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(confirmSchema)) _b: { confirm: true }) {
    return this.refunds.process(a, id);
  }

  @RequirePermission("payments.reconcile")
  @Post("refunds/:id/reconcile")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reconcileRefund(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(emptyBodySchema)) _b: unknown) {
    return this.refunds.reconcile(a, id);
  }
}

