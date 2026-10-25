import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import type { BookingStatus } from "../../generated/prisma/enums.js";
import { PrismaService } from "../../prisma/prisma.service.js";

export type BookingListQuery = {
  status?: BookingStatus;
  q?: string;
  categoryId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

/**
 * Read-only monitoring of bookings. The list carries no street addresses or free text; the detail
 * (bookings.read) shows what support needs to help, still without e-mail addresses or phone
 * numbers. Nothing here changes a booking: state changes go through the dispute workflow.
 */
@Injectable()
export class AdminBookingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: BookingListQuery) {
    const term = q.q?.trim();
    const where: Prisma.BookingWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.categoryId && { categoryId: q.categoryId }),
      ...((q.from || q.to) && { startAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
      ...(term && {
        OR: [
          ...(/^[0-9a-f-]{36}$/i.test(term) ? [{ id: term }] : []),
          { customer: { name: { contains: term, mode: "insensitive" as const } } },
          { workerProfile: { displayName: { contains: term, mode: "insensitive" as const } } },
        ],
      }),
    };
    const [total, rows, grouped] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, status: true, startAt: true, endAt: true, createdAt: true, agreedAmountBdt: true, serviceArea: true, pricingModel: true,
          category: { select: { name: true, slug: true } },
          customer: { select: { id: true, name: true } },
          workerProfile: { select: { id: true, displayName: true } },
          dispute: { select: { id: true, status: true } },
          _count: { select: { payments: true } },
        },
      }),
      // status counts ignore the status filter, so the tabs show what each status would contain
      this.prisma.booking.groupBy({ by: ["status"], where: { ...where, status: undefined }, _count: { _all: true } }),
    ]);
    return {
      bookings: rows.map((b) => ({
        id: b.id, status: b.status, startAt: b.startAt, endAt: b.endAt, createdAt: b.createdAt, serviceArea: b.serviceArea,
        pricingModel: b.pricingModel, agreedAmountBdt: b.agreedAmountBdt, category: b.category,
        customer: b.customer, worker: { id: b.workerProfile.id, displayName: b.workerProfile.displayName },
        dispute: b.dispute, paymentCount: b._count.payments,
      })),
      statusCounts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize),
    };
  }

  async get(id: string) {
    const b = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        id: true, status: true, description: true, serviceArea: true, serviceAddress: true, startAt: true, endAt: true, durationMinutes: true, timezone: true,
        pricingModel: true, unitPriceBdt: true, agreedAmountBdt: true, currency: true, createdAt: true, confirmedAt: true, startedAt: true,
        completionRequestedAt: true, completedAt: true, cancelledAt: true, cancellationReason: true,
        category: { select: { name: true, slug: true } },
        customer: { select: { id: true, name: true } },
        workerProfile: { select: { id: true, displayName: true } },
        dispute: { select: { id: true, status: true, category: true, createdAt: true } },
        review: { select: { id: true, rating: true, status: true } },
        quotes: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, status: true, totalBdt: true, createdAt: true, expiresAt: true } },
        payments: { orderBy: { createdAt: "desc" }, take: 20, select: { reference: true, provider: true, status: true, amountBdt: true, refundedAmountBdt: true, createdAt: true } },
        rescheduleRequests: { orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, newStartAt: true, createdAt: true } },
      },
    });
    if (!b) throw new NotFoundException("Booking not found");
    const events = await this.prisma.bookingEvent.findMany({
      where: { bookingId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 300,
      select: { id: true, type: true, actorRole: true, fromStatus: true, toStatus: true, reason: true, createdAt: true },
    });
    const { workerProfile, ...rest } = b;
    return { booking: { ...rest, worker: workerProfile, events } };
  }
}
