import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/decorators.js";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";

const DB_CHECK_TIMEOUT_MS = 2_000;

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * LIVENESS: the process is up and the event loop answers. Checks no
   * dependency on purpose, so a database outage makes the orchestrator stop
   * routing traffic (readiness) without restarting a healthy process.
   */
  @Public()
  @SkipThrottle()
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /**
   * READINESS: can this instance serve requests? Requires the database (the
   * only hard dependency). The AI service, payment providers and email are
   * optional or degrade gracefully, so they do NOT affect readiness; operators
   * see them at GET /admin/ops/status. Public and minimal: no versions, hosts,
   * or error details.
   */
  @Public()
  @Get(["health", "health/ready"])
  async ready() {
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_CHECK_TIMEOUT_MS).unref()),
      ]);
    } catch {
      throw new ServiceUnavailableException({ statusCode: 503, error: "Service Unavailable", message: "Not ready", checks: { database: "unavailable" } });
    }
    return { status: "ok", checks: { database: "ok" } };
  }

  /** Public, non-secret capability flags so the UI can render honest states. */
  @Public()
  @Get("config/auth")
  authConfig() {
    return {
      googleEnabled: this.env.googleEnabled,
      emailVerificationRequired: true,
      minPasswordLength: 10,
    };
  }
}
