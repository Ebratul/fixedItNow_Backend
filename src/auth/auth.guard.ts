import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { expandPermissions } from "../admin/permissions.js";
import { readSetting } from "../admin/settings/read-setting.js";
import { enterRealm } from "../common/request-context.js";
import { DEMO_ADMIN_PERMISSIONS, demoKeyOf, demoSettingKey } from "../demo/demo.config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AUTH, type Auth } from "./auth.factory.js";
import { IS_PUBLIC, OPTIONAL_AUTH } from "./decorators.js";

/**
 * Global authentication guard (default deny).
 *
 * Authentication only answers "who is this?". It establishes `req.auth` from a
 * session validated by Better Auth; the role is loaded from the database so it
 * cannot be forged or stale. What the caller may DO is decided by the
 * authorization guards/policies, not here.
 *
 * It also decides the request's data REALM (demo or real) from the database, before any handler runs, because
 * PrismaService filters every query by it (docs/DEMO.md). It reads users with the unscoped client: the realm is
 * what it is deciding, so it cannot already be filtered by it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublic) {
      // Public routes ignore the session unless they opt in (only to pick the realm; it never rejects).
      if (this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets)) {
        try {
          await this.authenticate(req);
        } catch {
          req.auth = undefined; // anonymous: the realm stays "real"
        }
      }
      return true;
    }
    await this.authenticate(req);
    return true;
  }

  private async authenticate(req: Request) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw new UnauthorizedException("Authentication required");

    // Defence in depth: a session for an unverified email is never valid.
    if (!session.user.emailVerified) {
      throw new ForbiddenException("Email address is not verified");
    }

    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: session.user.id },
      select: { role: true, suspendedAt: true, isDemo: true, demoRole: true, adminRole: { select: { permissions: true } } },
    });
    if (!user) throw new UnauthorizedException("Authentication required");
    // Restricted by an administrator. Their sessions are also revoked when this is set, so this
    // only matters for a session created in the same instant.
    if (user.suspendedAt) {
      throw new ForbiddenException({ statusCode: 403, error: "Forbidden", code: "ACCOUNT_SUSPENDED", message: "This account has been suspended. Please contact support." });
    }

    let permissions: string[] =
      user.role === "ADMIN" && user.adminRole ? [...expandPermissions(user.adminRole.permissions)] : [];
    if (user.isDemo) {
      // Only the three login identities may hold a session in the demo realm (the persona accounts have none).
      if (!user.demoRole) throw new UnauthorizedException("Authentication required");
      // An administrator may switch a demo role off at any time: the sessions it already issued stop working too.
      const key = demoKeyOf(user.demoRole);
      if (!(await readSetting(this.prisma, demoSettingKey(key, "enabled")))) {
        throw new UnauthorizedException({ statusCode: 401, error: "Unauthorized", code: "DEMO_DISABLED", message: "This demo is not available right now." });
      }
      // The demo administrator never holds more than the read-only allow-list, whatever its role row says.
      permissions = permissions.filter((p) => (DEMO_ADMIN_PERMISSIONS as readonly string[]).includes(p));
      // Fail closed: if the request context that carries the realm is missing, a demo session is refused.
      if (!enterRealm("demo")) throw new InternalServerErrorException("Request context unavailable");
    } else {
      enterRealm("real");
    }

    req.auth = {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified,
      sessionId: session.session.id,
      role: user.role,
      permissions,
      demo: user.demoRole,
    };
  }
}
