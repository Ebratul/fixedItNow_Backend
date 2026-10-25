import { Controller, Get, Inject } from "@nestjs/common";
import { AiClient } from "../../ai/ai-client.js";
import { RequirePermission } from "../../auth/decorators.js";
import { ENV, type Env } from "../../config/env.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { SettingsService } from "../settings/settings.service.js";

const STUCK_MINUTES = 30;

type IntegrationStatus = "ok" | "degraded" | "down" | "not_configured" | "sandbox" | "live" | "off";

/**
 * Operational view for administrators (FR-ADM-07): dependency status and the work queues that need
 * a human. Counts, states and booleans only: no credentials, hosts, URLs, personal data or payment
 * details. "Configured" means the environment variables are present; nothing here proves a
 * third-party account works (only the database and the AI service are actually probed).
 */
@RequirePermission("ops.read")
@Controller("admin/ops")
export class OpsController {
  private aiCache: { at: number; value: { configured: boolean; reachable?: boolean; llm?: string | null } } | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("status")
  async status() {
    const p = this.prisma;
    const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60_000);
    const dbStart = Date.now();
    await p.$queryRaw`SELECT 1`;
    const databaseLatencyMs = Date.now() - dbStart;

    const [paymentsReview, paymentsStuck, refundsProcessing, refundsRequested, disputesOpen, reportsOpen, ticketsOpen, ticketsUnassigned, migrations, auditHead, maintenance, ai] = await Promise.all([
      p.payment.count({ where: { status: "REQUIRES_REVIEW" } }),
      p.payment.count({ where: { status: { in: ["INITIATED", "PROCESSING"] }, updatedAt: { lt: stuckBefore } } }),
      p.refund.count({ where: { status: "PROCESSING" } }),
      p.refund.count({ where: { status: "REQUESTED" } }),
      p.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"] } } }),
      p.contentReport.count({ where: { status: { in: ["OPEN", "REVIEWING"] } } }),
      p.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      p.supportTicket.count({ where: { status: "OPEN", assigneeId: null } }),
      p.$queryRaw<{ applied: number; failed: number }[]>`SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied, COUNT(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::int AS failed FROM "_prisma_migrations"`.catch(() => [{ applied: 0, failed: 0 }]),
      p.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, createdAt: true } }),
      this.settings.get("platform.maintenanceMode"),
      this.aiStatus(),
    ]);

    const payments = {
      bkash: this.env.bkash ? (this.env.bkash.isLive ? "live" : "sandbox") : "not_configured",
      refundsEnabled: { bkash: this.env.bkash?.refundsEnabled ?? false },
    };
    const integrations: { id: string; label: string; status: IntegrationStatus; detail: string; probed: boolean }[] = [
      { id: "database", label: "Database (PostgreSQL)", status: databaseLatencyMs > 1500 ? "degraded" : "ok", detail: `Answered in ${databaseLatencyMs} ms`, probed: true },
      { id: "migrations", label: "Database migrations", status: migrations[0]!.failed > 0 ? "down" : "ok", detail: `${migrations[0]!.applied} applied${migrations[0]!.failed ? `, ${migrations[0]!.failed} failed` : ""}`, probed: true },
      { id: "ai", label: "AI assistant service", status: !ai.configured ? "not_configured" : ai.reachable ? "ok" : "down", detail: !ai.configured ? "AI_SERVICE_URL / tokens are not set" : ai.reachable ? `Reachable; language model: ${ai.llm ?? "unknown"}` : "Configured but not answering", probed: ai.configured },
      { id: "bkash", label: "bKash", status: payments.bkash as IntegrationStatus, detail: this.env.bkash ? `Credentials present (${payments.bkash}); not verified against bKash from here. Refunds ${this.env.bkash.refundsEnabled ? "enabled" : "disabled"}` : "Credentials are not set", probed: false },
      { id: "mail", label: "Email delivery", status: this.env.MAIL_TRANSPORT === "smtp" ? "ok" : "off", detail: this.env.MAIL_TRANSPORT === "smtp" ? "SMTP transport configured (delivery is not probed)" : "Console transport: emails are printed to the server log, not delivered", probed: false },
      { id: "google", label: "Google sign-in", status: this.env.googleEnabled ? "ok" : "not_configured", detail: this.env.googleEnabled ? "OAuth client configured" : "GOOGLE_CLIENT_ID / SECRET are not set", probed: false },
      { id: "documents", label: "Private document storage", status: this.env.documents ? "ok" : "not_configured", detail: this.env.documents ? "Encryption key present; documents are sealed with AES-256-GCM" : "DOCUMENT_ENCRYPTION_KEY is not set: identity-document uploads are disabled", probed: false },
    ];

    return {
      database: "ok",
      databaseLatencyMs,
      ai,
      payments,
      mail: this.env.MAIL_TRANSPORT,
      integrations,
      queues: {
        paymentsRequiringReview: paymentsReview,
        paymentsUnresolvedOver30Minutes: paymentsStuck,
        refundsAwaitingProvider: refundsProcessing,
        refundsAwaitingDecision: refundsRequested,
        disputesOpen,
        reportsOpen,
        ticketsOpen,
        ticketsUnassigned,
      },
      audit: auditHead ? { headSeq: auditHead.seq, lastEntryAt: auditHead.createdAt } : { headSeq: 0, lastEntryAt: null },
      platform: { maintenanceMode: maintenance },
      runtime: { environment: this.env.NODE_ENV, node: process.version, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) },
    };
  }

  /** AI service reachability, cached for 15 s so repeated page loads do not hammer it. */
  private async aiStatus() {
    if (!this.env.ai) return { configured: false as const };
    if (this.aiCache && Date.now() - this.aiCache.at < 15_000) return this.aiCache.value;
    const health = await this.ai.health();
    const value = { configured: true, reachable: health !== null, llm: health?.llm ?? null };
    this.aiCache = { at: Date.now(), value };
    return value;
  }
}
