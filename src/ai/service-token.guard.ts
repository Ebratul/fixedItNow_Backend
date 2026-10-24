import { type CanActivate, type ExecutionContext, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { ENV, type Env } from "../config/env.js";

/**
 * Authenticates the AI service on /internal/ai/*. These routes are @Public()
 * (no user session exists for a service call), so THIS guard is their only
 * protection: it fails closed when the assistant is not configured, compares the
 * bearer token in constant time, and grants nothing beyond the read-only public
 * projections those routes return.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const ai = this.env.ai;
    // Not configured: behave as if the route does not exist.
    if (!ai) throw new NotFoundException();
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? "";
    const [scheme, token = ""] = header.split(" ");
    const expected = Buffer.from(ai.appApiToken);
    const supplied = Buffer.from(token);
    const same = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (scheme !== "Bearer" || !same) throw new UnauthorizedException("Service authentication failed");
    return true;
  }
}
