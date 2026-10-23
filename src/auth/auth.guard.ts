import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service.js";
import { AUTH, type Auth } from "./auth.factory.js";
import { IS_PUBLIC } from "./decorators.js";

/**
 * Global authentication guard (default deny).
 *
 * Authentication only answers "who is this?". It establishes `req.auth` from a
 * session validated by Better Auth; the role is loaded from the database so it
 * cannot be forged or stale. What the caller may DO is decided by the
 * authorization guards/policies, not here.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw new UnauthorizedException("Authentication required");

    // Defence in depth: a session for an unverified email is never valid.
    if (!session.user.emailVerified) {
      throw new ForbiddenException("Email address is not verified");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    if (!user) throw new UnauthorizedException("Authentication required");

    req.auth = {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified,
      sessionId: session.session.id,
      role: user.role,
    };
    return true;
  }
}
