import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ratingSummaries } from "../reviews/ratings.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";
import { cardSelect, toCard } from "../workers/workers.service.js";

const MAX_IDS = 500;

/** Every method is scoped to `auth.userId`; ids from the client never select a user. */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent add. Only publicly listed workers can be newly favourited. */
  async add(auth: AuthContext, workerProfileId: string) {
    const worker = await this.prisma.workerProfile.findFirst({
      where: { ...ELIGIBLE_WORKER, id: workerProfileId },
      select: { id: true, userId: true },
    });
    if (!worker) throw new NotFoundException("Professional not found");
    if (worker.userId === auth.userId) {
      throw new BadRequestException("You cannot favourite your own profile");
    }
    // Unique (userId, workerProfileId): concurrent duplicates collapse to one row.
    await this.prisma.favorite.createMany({
      data: [{ userId: auth.userId, workerProfileId: worker.id }],
      skipDuplicates: true,
    });
    return { favorited: true };
  }

  /** Idempotent remove. Allowed even if the worker has since become ineligible. */
  async remove(auth: AuthContext, workerProfileId: string) {
    await this.prisma.favorite.deleteMany({
      where: { userId: auth.userId, workerProfileId },
    });
    return { favorited: false };
  }

  /** Ids of the caller's favourites that are still publicly listed. */
  async ids(auth: AuthContext) {
    const rows = await this.prisma.favorite.findMany({
      where: { userId: auth.userId, workerProfile: ELIGIBLE_WORKER },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: MAX_IDS,
      select: { workerProfileId: true },
    });
    return { ids: rows.map((r) => r.workerProfileId) };
  }

  /** The caller's favourites as public cards; ineligible workers are hidden. */
  async list(auth: AuthContext, page: number, pageSize: number) {
    const where = { userId: auth.userId, workerProfile: ELIGIBLE_WORKER };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.favorite.count({ where }),
      this.prisma.favorite.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { workerProfile: { select: cardSelect } },
      }),
    ]);
    const ratings = await ratingSummaries(this.prisma, rows.map((r) => r.workerProfile.id));
    return {
      workers: rows.map((r) => toCard(r.workerProfile, ratings.get(r.workerProfile.id))),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }
}
