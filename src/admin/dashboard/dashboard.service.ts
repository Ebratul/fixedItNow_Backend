import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { currentRealm } from "../../common/request-context.js";
import { PrismaService } from "../../prisma/prisma.service.js";

type Point = { date: string; value: number };

/**
 * Dashboard figures: every number is an aggregate computed from the database at request time.
 * There are no names, e-mail addresses, addresses or identity data here (FR-ADM-06). Items that
 * belong to a module are included only if the caller may use that module, so the dashboard never
 * hints at data the admin cannot open. Days are Asia/Dhaka calendar days.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // Raw SQL is not filtered by the realm firewall (docs/DEMO.md), so every series names the realm itself: a demo
  // administrator charts demo data, a real one never counts a demo account or booking.
  private series(table: "user" | "booking", column: "createdAt", days: number): Promise<Point[]> {
    const realm = table === "user" ? `AND t."isDemo" = $2` : `AND t."customerId" IN (SELECT "id" FROM "user" WHERE "isDemo" = $2)`;
    // Identifiers are fixed literals chosen above, never user input.
    return this.prisma.$queryRawUnsafe<Point[]>(
      `WITH d AS (
         SELECT generate_series(date_trunc('day', (now() AT TIME ZONE 'Asia/Dhaka')) - ($1::int - 1) * interval '1 day', date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka'), interval '1 day') AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COUNT(t."id")::int AS value
       FROM d LEFT JOIN "${table}" t ON date_trunc('day', t."${column}" AT TIME ZONE 'Asia/Dhaka') = d.day ${realm}
       GROUP BY d.day ORDER BY d.day`,
      days,
      currentRealm() === "demo",
    );
  }

  private collected(days: number): Promise<Point[]> {
    const demo = currentRealm() === "demo";
    return this.prisma.$queryRaw<Point[]>`
      WITH d AS (
        SELECT generate_series(date_trunc('day', (now() AT TIME ZONE 'Asia/Dhaka')) - (${days}::int - 1) * interval '1 day', date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka'), interval '1 day') AS day
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COALESCE(SUM(p."amountBdt"), 0)::int AS value
      FROM d LEFT JOIN "payment" p
        ON date_trunc('day', p."succeededAt" AT TIME ZONE 'Asia/Dhaka') = d.day AND p."status"::text IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND p."customerId" IN (SELECT "id" FROM "user" WHERE "isDemo" = ${demo})
      GROUP BY d.day ORDER BY d.day`;
  }

  async get(admin: AuthContext, days: number) {
    const can = new Set(admin.permissions);
    const since = new Date(Date.now() - days * 86_400_000);
    const p = this.prisma;

    const [users, newUsers, suspendedUsers, customers, workersByStatus, workersPublished, bookingsByStatus, bookingsNew, userSeries, bookingSeries] = await Promise.all([
      p.user.count(),
      p.user.count({ where: { createdAt: { gte: since } } }),
      p.user.count({ where: { suspendedAt: { not: null } } }),
      p.customerProfile.count(),
      p.workerProfile.groupBy({ by: ["verificationStatus"], _count: { _all: true } }),
      p.workerProfile.count({ where: { publishedAt: { not: null }, suspendedAt: null } }),
      p.booking.groupBy({ by: ["status"], _count: { _all: true } }),
      p.booking.count({ where: { createdAt: { gte: since } } }),
      this.series("user", "createdAt", days),
      this.series("booking", "createdAt", days),
    ]);

    const attention: { key: string; label: string; count: number; href: string }[] = [];
    const add = async (permission: string, key: string, label: string, href: string, count: () => Promise<number>) => {
      if (can.has(permission)) attention.push({ key, label, count: await count(), href });
    };
    await Promise.all([
      add("workers.read", "workerReviews", "Worker applications to review", "/admin/workers", () => p.workerProfile.count({ where: { verificationStatus: "PENDING" } })),
      add("disputes.read", "disputes", "Open disputes", "/admin/disputes", () => p.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"] } } })),
      add("payments.read", "refundDecisions", "Refund requests awaiting a decision", "/admin/payments?tab=refunds", () => p.refund.count({ where: { status: "REQUESTED" } })),
      add("payments.read", "paymentsReview", "Payments needing review", "/admin/payments", () => p.payment.count({ where: { OR: [{ status: "REQUIRES_REVIEW" }, { reviewReason: "BOOKING_INELIGIBLE" }] } })),
      add("moderation.read", "contentReports", "Open content reports", "/admin/moderation", () => p.contentReport.count({ where: { status: { in: ["OPEN", "REVIEWING"] } } })),
      add("support.read", "tickets", "Open support tickets", "/admin/support", () => p.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } })),
    ]);
    const order = ["workerReviews", "disputes", "refundDecisions", "paymentsReview", "contentReports", "tickets"];
    attention.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

    const finance = can.has("finance.reports")
      ? await (async () => {
          const [series, sum, refunds] = await Promise.all([
            this.collected(days),
            p.payment.aggregate({ where: { status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] }, succeededAt: { gte: since } }, _sum: { amountBdt: true }, _count: { _all: true } }),
            p.refund.aggregate({ where: { status: "SUCCEEDED", completedAt: { gte: since } }, _sum: { approvedAmountBdt: true } }),
          ]);
          const collected = sum._sum.amountBdt ?? 0;
          const refunded = refunds._sum.approvedAmountBdt ?? 0;
          return { collectedBdt: collected, refundedBdt: refunded, netBdt: collected - refunded, payments: sum._count._all, series };
        })()
      : null;

    const recentActivity = can.has("audit.read")
      ? (await p.auditLog.findMany({ orderBy: { seq: "desc" }, take: 8, select: { id: true, action: true, targetType: true, createdAt: true, actor: { select: { name: true } } } })).map((a) => ({
          id: a.id, action: a.action, targetType: a.targetType, at: a.createdAt, by: a.actor?.name ?? "system",
        }))
      : null;

    const workerCount = (status: string) => workersByStatus.find((w) => w.verificationStatus === status)?._count._all ?? 0;
    return {
      generatedAt: new Date(),
      days,
      users: { total: users, new: newUsers, suspended: suspendedUsers, customers },
      workers: {
        total: workersByStatus.reduce((n, w) => n + w._count._all, 0),
        verified: workerCount("VERIFIED"), pending: workerCount("PENDING"), rejected: workerCount("REJECTED"),
        resubmission: workerCount("RESUBMISSION_REQUIRED"), notSubmitted: workerCount("NOT_SUBMITTED"), published: workersPublished,
      },
      bookings: {
        total: bookingsByStatus.reduce((n, b) => n + b._count._all, 0),
        new: bookingsNew,
        byStatus: Object.fromEntries(bookingsByStatus.map((b) => [b.status, b._count._all])),
      },
      attention,
      trends: { newUsers: userSeries, bookings: bookingSeries },
      finance,
      recentActivity,
    };
  }
}
