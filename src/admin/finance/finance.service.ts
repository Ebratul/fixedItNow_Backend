import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { currentRealm } from "../../common/request-context.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { csvCell } from "../audit/audit-query.service.js";

export type Range = { from: Date; to: Date };
const COLLECTED = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
export const MAX_RANGE_DAYS = 366;

type DayRow = { day: string; collected: number; refunded: number };

/**
 * Money reports computed from verified rows only: a payment counts once it is SUCCEEDED /
 * PARTIALLY_REFUNDED / REFUNDED (status set only after the provider confirmed it), and a refund
 * counts once its status is SUCCEEDED (confirmed by the provider). Days are Asia/Dhaka calendar days.
 *
 * COMMISSION IS REPORTING ONLY: the platform currently charges no fee and deducts nothing from
 * workers (docs/PAYMENTS.md). The commission figure is `net x rate`, using the configured rate
 * (setting `finance.commissionBps`) or a rate passed for what-if analysis. It is not a ledger.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Raw SQL is not filtered by the realm firewall, so each report names the realm itself: only the customers of the
   * caller's realm (demo or real), so demo payments never reach real revenue figures and real ones never reach a demo screen.
   */
  private realmCustomers() {
    return Prisma.sql`SELECT "id" FROM "user" WHERE "isDemo" = ${currentRealm() === "demo"}`;
  }

  private async daily({ from, to }: Range): Promise<DayRow[]> {
    const customers = this.realmCustomers();
    return this.prisma.$queryRaw<DayRow[]>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${from}::timestamptz AT TIME ZONE 'Asia/Dhaka'),
          date_trunc('day', (${to}::timestamptz - interval '1 millisecond') AT TIME ZONE 'Asia/Dhaka'),
          interval '1 day') AS d
      ),
      paid AS (
        SELECT date_trunc('day', "succeededAt" AT TIME ZONE 'Asia/Dhaka') AS d, SUM("amountBdt")::int AS amount
        FROM "payment"
        WHERE "status"::text = ANY(${[...COLLECTED]}) AND "succeededAt" >= ${from} AND "succeededAt" < ${to}
          AND "customerId" IN (${customers})
        GROUP BY 1
      ),
      refunded AS (
        SELECT date_trunc('day', "completedAt" AT TIME ZONE 'Asia/Dhaka') AS d, SUM(COALESCE("approvedAmountBdt", 0))::int AS amount
        FROM "refund"
        WHERE "status" = 'SUCCEEDED' AND "completedAt" >= ${from} AND "completedAt" < ${to}
          AND "paymentId" IN (SELECT "id" FROM "payment" WHERE "customerId" IN (${customers}))
        GROUP BY 1
      )
      SELECT to_char(days.d, 'YYYY-MM-DD') AS day, COALESCE(paid.amount, 0)::int AS collected, COALESCE(refunded.amount, 0)::int AS refunded
      FROM days LEFT JOIN paid ON paid.d = days.d LEFT JOIN refunded ON refunded.d = days.d
      ORDER BY days.d`;
  }

  async summary(range: Range) {
    const customers = this.realmCustomers();
    const [days, byProvider, byStatus, byCategory, pending] = await Promise.all([
      this.daily(range),
      this.prisma.payment.groupBy({
        by: ["provider"], where: { status: { in: [...COLLECTED] }, succeededAt: { gte: range.from, lt: range.to } },
        _sum: { amountBdt: true }, _count: { _all: true },
      }),
      this.prisma.payment.groupBy({ by: ["status"], where: { createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ name: string; collected: number; payments: number }[]>`
        SELECT c."name" AS name, SUM(p."amountBdt")::int AS collected, COUNT(*)::int AS payments
        FROM "payment" p JOIN "booking" b ON b."id" = p."bookingId" JOIN "service_category" c ON c."id" = b."categoryId"
        WHERE p."status"::text = ANY(${[...COLLECTED]}) AND p."succeededAt" >= ${range.from} AND p."succeededAt" < ${range.to}
          AND p."customerId" IN (${customers})
        GROUP BY c."name" ORDER BY collected DESC LIMIT 20`,
      this.prisma.refund.aggregate({ where: { status: { in: ["REQUESTED", "APPROVED", "PROCESSING"] } }, _count: { _all: true }, _sum: { requestedAmountBdt: true } }),
    ]);
    const collected = days.reduce((n, d) => n + d.collected, 0);
    const refunded = days.reduce((n, d) => n + d.refunded, 0);
    return {
      range: { from: range.from, to: range.to },
      currency: "BDT",
      totals: { collectedBdt: collected, refundedBdt: refunded, netBdt: collected - refunded, successfulPayments: byProvider.reduce((n, p) => n + p._count._all, 0) },
      byProvider: byProvider.map((p) => ({ provider: p.provider, collectedBdt: p._sum.amountBdt ?? 0, payments: p._count._all })),
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      byCategory: byCategory.map((c) => ({ category: c.name, collectedBdt: c.collected, payments: c.payments })),
      pendingRefunds: { count: pending._count._all, requestedBdt: pending._sum.requestedAmountBdt ?? 0 },
      daily: days,
    };
  }

  async commission(range: Range, rateBps?: number) {
    const configured = await this.settings.get("finance.commissionBps");
    const rate = rateBps ?? configured;
    const days = await this.daily(range);
    const rows = days.map((d) => ({ day: d.day, collectedBdt: d.collected, refundedBdt: d.refunded, netBdt: d.collected - d.refunded, commissionBdt: Math.round(((d.collected - d.refunded) * rate) / 10_000) }));
    const collected = rows.reduce((n, r) => n + r.collectedBdt, 0);
    const refunded = rows.reduce((n, r) => n + r.refundedBdt, 0);
    return {
      range: { from: range.from, to: range.to },
      currency: "BDT",
      rateBps: rate,
      rateSource: rateBps === undefined ? ("setting" as const) : ("override" as const),
      configuredRateBps: configured,
      totals: { collectedBdt: collected, refundedBdt: refunded, netBdt: collected - refunded, commissionBdt: Math.round(((collected - refunded) * rate) / 10_000) },
      reportingOnly: true,
      note: "Reporting only: no fee is charged to customers or deducted from workers. Commission is net collected x rate for the period; refunds count on the day they were confirmed.",
      daily: rows,
    };
  }

  async commissionCsv(admin: AuthContext, range: Range, rateBps?: number) {
    const report = await this.commission(range, rateBps);
    await this.audit.record(this.prisma, {
      actorId: admin.userId, action: "finance.export", targetType: "Report", targetId: "commission",
      metadata: { from: range.from, to: range.to, rateBps: report.rateBps, days: report.daily.length },
    });
    const header = ["day", "collected_bdt", "refunded_bdt", "net_bdt", `commission_bdt_at_${report.rateBps}_bps`];
    const lines = report.daily.map((r) => [r.day, r.collectedBdt, r.refundedBdt, r.netBdt, r.commissionBdt].map(csvCell).join(","));
    return `${header.join(",")}\n${lines.join("\n")}\n`;
  }
}
