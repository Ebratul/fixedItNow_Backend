import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
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
 * construction (see ELIGIBLE_WORKER). Ratings do not exist yet (no reviews
 * feature), so they are explicitly null/0 rather than invented.
 */
export function toCard(row: CardRow) {
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
    rating: null,
    reviewCount: 0,
    publishedAt: row.publishedAt,
  };
}

function toProfile(row: ProfileRow) {
  return {
    ...toCard({ ...row, services: row.services }),
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

@Injectable()
export class WorkersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public search. Visibility is enforced by spreading ELIGIBLE_WORKER first,
   * so no filter or sort can widen the result set. Text matching uses Prisma's
   * parameterised `contains` (case-insensitive); no SQL is built from input.
   *
   * Each whitespace-separated term must match the name, headline, bio, or an
   * active category name (AND across terms, OR across fields).
   */
  async search(query: SearchQuery) {
    const terms = searchTerms(query.q);
    const where: Prisma.WorkerProfileWhereInput = {
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
        services: { some: { category: { slug: query.category, isActive: true } } },
      }),
      ...(query.location && { serviceAreas: { has: query.location } }),
      // Workers with no priced service (quote-only) are excluded by a price cap.
      ...(query.maxPrice !== undefined && { startingPriceBdt: { lte: query.maxPrice } }),
      ...(query.minExperience !== undefined && {
        experienceYears: { gte: query.minExperience },
      }),
    };

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

    return {
      workers: rows.map(toCard),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      sort: query.sort,
    };
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
    return toProfile(row);
  }
}
