import { Controller, Get, Inject } from "@nestjs/common";
import { AiClient } from "../ai/ai-client.js";
import { RequireAdmin } from "../auth/decorators.js";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";

const STUCK_MINUTES = 30;

/**
 * Operational view for administrators (FR-ADM-07): dependency status and the
 * work queues that need a human. Counts and booleans only: no credentials,
 * hosts, URLs, personal data or payment details.
 */
@RequireAdmin()
@Controller("admin/ops")
export class OpsController {
  private aiCache: { at: number; value: unknown } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("status")
  async status() {
    const p = this.prisma;
    const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60_000);
    const [paymentsReview, paymentsStuck, refundsProcessing, refundsRequested, disputesOpen, reportsOpen] = await Promise.all([
      p.payment.count({ where: { status: "REQUIRES_REVIEW" } }),
      p.payment.count({ where: { status: { in: ["INITIATED", "PROCESSING"] }, updatedAt: { lt: stuckBefore } } }),
      p.refund.count({ where: { status: "PROCESSING" } }),
      p.refund.count({ where: { status: "REQUESTED" } }),
      p.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"] } } }),
      p.contentReport.count({ where: { status: { in: ["OPEN", "REVIEWING"] } } }),
    ]);
    return {
      database: "ok",
      ai: await this.aiStatus(),
      payments: {
        bkash: this.env.bkash ? (this.env.bkash.isLive ? "live" : "sandbox") : "not_configured",
        sslcommerz: this.env.sslcommerz ? (this.env.sslcommerz.isLive ? "live" : "sandbox") : "not_configured",
        refundsEnabled: { bkash: this.env.bkash?.refundsEnabled ?? false, sslcommerz: this.env.sslcommerz?.refundsEnabled ?? false },
      },
      mail: this.env.MAIL_TRANSPORT,
      queues: {
        paymentsRequiringReview: paymentsReview,
        paymentsUnresolvedOver30Minutes: paymentsStuck,
        refundsAwaitingProvider: refundsProcessing,
        refundsAwaitingDecision: refundsRequested,
        disputesOpen,
        reportsOpen,
      },
    };
  }

  /** AI service reachability, cached for 15 s so repeated page loads do not hammer it. */
  private async aiStatus() {
    if (!this.env.ai) return { configured: false };
    if (this.aiCache && Date.now() - this.aiCache.at < 15_000) return this.aiCache.value;
    const health = await this.ai.health();
    const value = { configured: true, reachable: health !== null, llm: health?.llm ?? null };
    this.aiCache = { at: Date.now(), value };
    return value;
  }
}
