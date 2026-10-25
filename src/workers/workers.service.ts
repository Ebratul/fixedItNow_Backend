import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { NO_REVIEWS, ratingSummaries, type RatingSummary } from "../reviews/ratings.js";
import { ELIGIBLE_WORKER } from "./eligibility.js";
import { isValidSlug } from "./slug.js";
import { searchTerms, type SearchQuery, type WorkerSort } from "./workers.schema.js";

/** Only ACTIVE categories are ever shown on a worker. */
const activeServices = {
  where: { category: { isActive: true } },
  orderBy: [{ category: { sortOrder: "asc" } }, { category: { slug: "asc" } }],
} satisfies Prisma.WorkerProfile$servicesArgs;

/**
 * Explicit public projection for listing cards. Anything not selected here
 * (user id, email, review notes, suspension data, ...) cannot leak.
 */
export const cardSelect = {
  id: true,
  slug: true,
  displayName: true,
  headline: true,
  experienceYears: true,
  serviceAreas: true,
  startingPriceBdt: true,
  publishedAt: true,
  services: {
    ...activeServices,
    select: { category: { select: { slug: true, name: true } } },
  },
} as const satisfies Prisma.WorkerProfileSelect;

const profileSelect = {
  id: true,
  slug: true,
  displayName: true,
  headline: true,
  bio: true,
  experienceYears: true,
  languages: true,
  serviceAreas: true,
  startingPriceBdt: true,
  publishedAt: true,
  updatedAt: true,
  services: {
    ...activeServices,
    select: {
      pricingModel: true,
      basePriceBdt: true,
      pricingNotes: true,
      category: { select: { slug: true, name: true } },
    },
  },
} as const satisfies Prisma.WorkerProfileSelect;

type CardRow = Prisma.WorkerProfileGetPayload<{ select: typeof cardSelect }>;
type ProfileRow = Prisma.WorkerProfileGetPayload<{ select: typeof profileSelect }>;

/**
 * Public card shape. `verification` is "VERIFIED" for every listed worker by
 * construction (see ELIGIBLE_WORKER). `rating`/`reviewCount` come from counted
 * reviews only (reviews/ratings.ts); a worker with none is null/0, never invented.
 */
export function toCard(row: CardRow, summary: RatingSummary = NO_REVIEWS) {
  const categories = row.services.map((s) => s.category);
  return {
    id: row.id,
    slug: row.slug!,
    displayName: row.displayName ?? "Unnamed professional",
    headline: row.headline,
    primaryCategory: categories[0] ?? null,
    categories,
    serviceAreas: row.serviceAreas,
    experienceYears: row.experienceYears,
    startingPriceBdt: row.startingPriceBdt,
    verification: "VERIFIED" as const,
    rating: summary.rating,
    reviewCount: summary.reviewCount,
    publishedAt: row.publishedAt,
  };
}

function toProfile(row: ProfileRow, summary: RatingSummary) {
  return {
    ...toCard({ ...row, services: row.services }, summary),
    bio: row.bio,
    languages: row.languages,
    updatedAt: row.updatedAt,
    services: row.services.map((s) => ({
      category: s.category,
      pricingModel: s.pricingModel,
      basePriceBdt: s.basePriceBdt,
      pricingNotes: s.pricingNotes,
    })),
  };
}

/** Fixed ORDER BY per sort key, always ending in a unique tiebreaker (id). */
const ORDERINGS: Record<WorkerSort, Prisma.WorkerProfileOrderByWithRelationInput[]> = {
  newest: [{ publishedAt: "desc" }, { id: "asc" }],
  experience: [
    { experienceYears: { sort: "desc", nulls: "last" } },
    { publishedAt: "desc" },
    { id: "asc" },
  ],
  price_asc: [
    { startingPriceBdt: { sort: "asc", nulls: "last" } },
    { publishedAt: "desc" },
    { id: "asc" },
  ],
  price_desc: [
    { startingPriceBdt: { sort: "desc", nulls: "last" } },
    { publishedAt: "desc" },
    { id: "asc" },
  ],
};

/**
 * The ONE place a public search `where` is built. Visibility is enforced by
 * spreading ELIGIBLE_WORKER first, so no filter can widen the result set. Text
 * matching uses Prisma's parameterised `contains` (case-insensitive); no SQL is
 * built from input. Each whitespace-separated term must match the name,
 * headline, bio, or an active category name (AND across terms, OR across fields).
 */
export function buildSearchWhere(
  query: Pick<SearchQuery, "q" | "category" | "location" | "maxPrice" | "minExperience">,
): Prisma.WorkerProfileWhereInput {
  const terms = searchTerms(query.q);
  return {
    ...ELIGIBLE_WORKER,
    AND: terms.map((term) => ({
      OR: [
        { displayName: { contains: term, mode: "insensitive" } },
        { headline: { contains: term, mode: "insensitive" } },
        { bio: { contains: term, mode: "insensitive" } },
        {
          services: {
            some: {
              category: { isActive: true, name: { contains: term, mode: "insensitive" } },
            },
          },
        },
      ],
    })),
    ...(query.category && {
      // A parent category also matches workers listed under its (active) subcategories.
      services: { some: { category: { isActive: true, OR: [{ slug: query.category }, { parent: { slug: query.category, isActive: true } }] } } },
    }),
    ...(query.location && { serviceAreas: { has: query.location } }),
    // Workers with no priced service (quote-only) are excluded by a price cap.
    ...(query.maxPrice !== undefined && { startingPriceBdt: { lte: query.maxPrice } }),
    ...(query.minExperience !== undefined && {
      experienceYears: { gte: query.minExperience },
    }),
  };
}

@Injectable()
export class WorkersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public search (see buildSearchWhere for the visibility and matching rules). */
  async search(query: SearchQuery) {
    const where = buildSearchWhere(query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.workerProfile.count({ where }),
      this.prisma.workerProfile.findMany({
        where,
        orderBy: ORDERINGS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: cardSelect,
      }),
    ]);

    const ratings = await ratingSummaries(this.prisma, rows.map((r) => r.id));
    return {
      workers: rows.map((r) => toCard(r, ratings.get(r.id))),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      sort: query.sort,
    };
  }

  /**
   * Re-reads the given ids as public cards, applying the same visibility rule
   * and the same filters as a search. Unknown, hidden, suspended and
   * filter-violating ids are simply absent from the result. Used to ground
   * references that came from another service.
   */
  async findCardsByIds(
    ids: string[],
    filters: Pick<SearchQuery, "category" | "location" | "maxPrice" | "minExperience">,
  ) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.workerProfile.findMany({
      where: { AND: [buildSearchWhere(filters), { id: { in: ids } }] },
      select: cardSelect,
    });
    const ratings = await ratingSummaries(this.prisma, rows.map((r) => r.id));
    return rows.map((r) => toCard(r, ratings.get(r.id)));
  }

  /**
   * Public profile by slug. Ineligible profiles (draft, unpublished, suspended,
   * unknown) all produce the same 404, revealing nothing about their existence.
   */
  async getBySlug(slug: string) {
    if (!isValidSlug(slug)) throw new NotFoundException("Professional not found");
    const row = await this.prisma.workerProfile.findFirst({
      where: { ...ELIGIBLE_WORKER, slug },
      select: profileSelect,
    });
    if (!row) throw new NotFoundException("Professional not found");
    return toProfile(row, (await ratingSummaries(this.prisma, [row.id])).get(row.id) ?? NO_REVIEWS);
  }
}
