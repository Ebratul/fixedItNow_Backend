import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  UseGuards,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import type { Permission } from "../admin/permissions.js";
import { PermissionGuard, REQUIRED_PERMISSIONS } from "./permission.guard.js";
import { ApprovedWorkerGuard } from "./approved-worker.guard.js";
import type { AuthContext, WorkerContext } from "./auth.types.js";

export const IS_PUBLIC = "isPublic";
export const OPTIONAL_AUTH = "optionalAuth";
export const SKIP_ORIGIN_CHECK = "skipOriginCheck";

/**
 * Opt a route OUT of authentication. Every route requires a valid session by
 * default (global AuthGuard), so forgetting a decorator fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * On a @Public() route: look at the session cookie anyway, WITHOUT requiring one, so the handler runs in the right
 * data realm (a demo visitor browsing the directory sees the demo professionals, everyone else the real ones). It
 * never rejects a request and never grants anything: an invalid, expired or missing session is just "anonymous".
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);

/**
 * Route requires an ADMIN holding ALL the listed permissions, read from the database on every
 * request. Put it on a controller for a shared minimum and on a handler to ask for more.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSIONS, permissions), UseGuards(PermissionGuard));

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

/**
 * Exempt a route from the browser-Origin (CSRF) check. ONLY for provider
 * callbacks, which are cross-site by nature (the payment provider's page posts
 * the customer's browser back to us, or the provider's server calls us). Such a
 * route must also be @Public(), must not use cookies, and must treat every field
 * as untrusted. A test asserts this decorator appears nowhere else.
 */
export const SkipOriginCheck = () => SetMetadata(SKIP_ORIGIN_CHECK, true);
