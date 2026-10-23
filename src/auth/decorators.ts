import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  UseGuards,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "./admin.guard.js";
import { ApprovedWorkerGuard } from "./approved-worker.guard.js";
import type { AuthContext, WorkerContext } from "./auth.types.js";

export const IS_PUBLIC = "isPublic";

/**
 * Opt a route OUT of authentication. Every route requires a valid session by
 * default (global AuthGuard), so forgetting a decorator fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires an ADMIN, checked against the database on every request. */
export const RequireAdmin = () => applyDecorators(UseGuards(AdminGuard));

/**
 * Route requires a worker whose profile was SUBMITTED and VERIFIED by an
 * authorised reviewer. Merely starting onboarding is not enough.
 */
export const RequireApprovedWorker = () =>
  applyDecorators(UseGuards(ApprovedWorkerGuard));

/** Injects the authenticated identity. Never read identity from body/query. */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.auth!;
  },
);

export const CurrentWorker = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): WorkerContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.worker!;
  },
);
