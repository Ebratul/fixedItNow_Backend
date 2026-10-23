import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../auth/decorators.js";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Get("health")
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("Database unavailable");
    }
    return { status: "ok" };
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
