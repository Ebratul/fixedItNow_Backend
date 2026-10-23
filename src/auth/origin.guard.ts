import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { ENV, type Env } from "../config/env.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the Origin
 * (or, failing that, Referer) must be the web app's origin. This complements
 * SameSite=Lax cookies. Better Auth applies its own equivalent check to /auth/*.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

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
