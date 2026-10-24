import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ENV, type Env } from "../config/env.js";
import { SKIP_ORIGIN_CHECK } from "./decorators.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the Origin
 * (or, failing that, Referer) must be the web app's origin. This complements
 * SameSite=Lax cookies. Better Auth applies its own equivalent check to /auth/*.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    // Provider callbacks only (see SkipOriginCheck).
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ORIGIN_CHECK, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const source = req.headers.origin ?? req.headers.referer;
    let origin: string | undefined;
    try {
      origin = source ? new URL(source).origin : undefined;
    } catch {
      origin = undefined;
    }
    if (origin !== this.env.frontendOrigin) {
      throw new ForbiddenException("Cross-origin request rejected");
    }
    return true;
  }
}
