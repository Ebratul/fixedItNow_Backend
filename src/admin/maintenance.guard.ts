import { type CanActivate, type ExecutionContext, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { SettingsService } from "./settings/settings.service.js";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Maintenance mode. Runs after authentication. While `platform.maintenanceMode` is on, a signed-in
 * NON-ADMIN user's writes answer 503; reads keep working. Not affected: administrators (they must
 * be able to switch it off), sign-in/sign-up (handled by Better Auth outside Nest) and payment
 * provider callbacks (public routes carry no `req.auth`), so money already in flight still lands.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth || req.auth.role === "ADMIN" || READ_ONLY.has(req.method)) return true;
    if (!(await this.settings.get("platform.maintenanceMode"))) return true;
    const message = (await this.settings.get("platform.maintenanceMessage")) || "FixedItNow is undergoing maintenance. You can browse, but changes are paused. Please try again soon.";
    throw new ServiceUnavailableException({ statusCode: 503, error: "Service Unavailable", code: "MAINTENANCE", message });
  }
}
