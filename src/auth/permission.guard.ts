import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Permission } from "../admin/permissions.js";

export const REQUIRED_PERMISSIONS = "requiredPermissions";

/**
 * Authorisation for admin routes. `req.auth` is built by the global AuthGuard from the DATABASE
 * (role, admin role, suspension), so nothing the client sends can add a permission. A route may
 * need several permissions; the caller must hold all of them. Fails closed: an ADMIN with no role
 * has no permissions, and a route without metadata is refused rather than allowed.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth || auth.role !== "ADMIN" || !required || required.length === 0) {
      throw new ForbiddenException("Administrator access required");
    }
    const held = new Set<string>(auth.permissions);
    if (!required.every((permission) => held.has(permission))) {
      throw new ForbiddenException({ statusCode: 403, error: "Forbidden", code: "PERMISSION_DENIED", message: "You do not have permission to do that" });
    }
    return true;
  }
}
