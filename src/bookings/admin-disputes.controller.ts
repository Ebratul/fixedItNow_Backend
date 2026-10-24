import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, RequireAdmin } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  adminDisputeListSchema,
  adminMessageSchema,
  adminRejectDisputeSchema,
  adminRequestInfoSchema,
  adminResolveSchema,
  emptyBodySchema,
} from "./booking.schemas.js";
import { DisputesService } from "./disputes.service.js";

/** Admin-only (AdminGuard reads the role from the database on every request). */
@RequireAdmin()
@Controller("admin/disputes")
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  list(@Query(new ZodPipe(adminDisputeListSchema)) q: { status?: string; page: number; pageSize: number }) {
    return this.disputes.adminList(q.status, q.page, q.pageSize);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.disputes.adminGet(id);
  }

  @Post(":id/review")
  @HttpCode(200)
  review(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(emptyBodySchema)) _b: unknown) {
    return this.disputes.adminReview(a, id);
  }

  @Post(":id/request-info")
  @HttpCode(200)
  requestInfo(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(adminRequestInfoSchema)) b: { message: string }) {
    return this.disputes.adminRequestInfo(a, id, b.message);
  }

  @Post(":id/messages")
  @HttpCode(200)
  message(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(adminMessageSchema)) b: { body: string; internal: boolean }) {
    return this.disputes.adminMessage(a, id, b.body, b.internal);
  }

  @Post(":id/resolve")
  @HttpCode(200)
  resolve(
    @CurrentAuth() a: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(adminResolveSchema)) b: { outcome: "MARK_COMPLETED" | "CANCEL_BOOKING" | "RESTORE_BOOKING"; resolution: string },
  ) {
    return this.disputes.adminResolve(a, id, b.outcome, b.resolution);
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(@CurrentAuth() a: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(adminRejectDisputeSchema)) b: { resolution: string }) {
    return this.disputes.adminReject(a, id, b.resolution);
  }
}
