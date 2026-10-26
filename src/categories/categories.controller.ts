import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OptionalAuth, Public } from "../auth/decorators.js";
import { currentRealm } from "../common/request-context.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";

/**
 * Read-only and public. Categories are managed by administrators (see admin/categories).
 * The list is the top-level categories, each with its active subcategories nested. Worker
 * counts are computed from publicly visible workers; a parent also counts the workers listed
 * under any of its subcategories (each worker once).
 */
@Controller("categories")
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Categories are shared by both data realms, but the worker COUNTS are not: a nested `_count` is not filtered by the realm
   * firewall (docs/DEMO.md), so it names the realm itself. A demo visitor counts demo professionals, everyone else real ones.
   */
  private base() {
    return {
      slug: true,
      name: true,
      description: true,
      // Real count of publicly visible workers in this category.
      _count: { select: { workerServices: { where: { workerProfile: { ...ELIGIBLE_WORKER, user: { suspendedAt: null, isDemo: currentRealm() === "demo" } } } } } },
    } as const;
  }

  private childSelect() {
    return {
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: this.base(),
    } satisfies Prisma.ServiceCategory$childrenArgs;
  }

  /** Distinct visible workers with a service in this parent or any of its active subcategories. */
  private async parentCounts(slugs: string[]) {
    if (slugs.length === 0) return new Map<string, number>();
    const demo = currentRealm() === "demo";
    const rows = await this.prisma.$queryRaw<{ slug: string; workers: number }[]>`
      SELECT p."slug" AS slug, COUNT(DISTINCT ws."workerProfileId")::int AS workers
      FROM "service_category" p
      JOIN "service_category" c ON c."id" = p."id" OR (c."parentId" = p."id" AND c."isActive")
      JOIN "worker_service" ws ON ws."categoryId" = c."id"
      JOIN "worker_profile" wp ON wp."id" = ws."workerProfileId"
      JOIN "user" u ON u."id" = wp."userId"
      WHERE p."slug" = ANY(${slugs}) AND p."isActive"
        AND wp."onboardingStatus" = 'SUBMITTED' AND wp."verificationStatus" = 'VERIFIED'
        AND wp."publishedAt" IS NOT NULL AND wp."suspendedAt" IS NULL AND wp."slug" IS NOT NULL AND u."suspendedAt" IS NULL
        AND u."isDemo" = ${demo}
      GROUP BY p."slug"`;
    return new Map(rows.map((r) => [r.slug, r.workers]));
  }

  /** Active top-level categories with their active subcategories and COMPUTED counts of listed professionals. */
  @Public()
  @OptionalAuth()
  @Get()
  async list() {
    const rows = await this.prisma.serviceCategory.findMany({
      where: { isActive: true, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { ...this.base(), children: this.childSelect() },
    });
    const counts = await this.parentCounts(rows.map((r) => r.slug));
    return {
      categories: rows.map(({ _count, children, ...category }) => ({
        ...category,
        workerCount: counts.get(category.slug) ?? 0,
        subcategories: children.map(({ _count: childCount, ...child }) => ({ ...child, workerCount: childCount.workerServices })),
      })),
    };
  }

  @Public()
  @OptionalAuth()
  @Get(":slug")
  async get(@Param("slug") slug: string) {
    const row = /^[a-z0-9-]{1,50}$/.test(slug)
      ? await this.prisma.serviceCategory.findFirst({
          where: { slug, isActive: true },
          select: { ...this.base(), parent: { select: { slug: true, name: true, isActive: true } }, children: this.childSelect() },
        })
      : null;
    if (!row || (row.parent && !row.parent.isActive)) throw new NotFoundException("Category not found");
    const { _count, children, parent, ...category } = row;
    const workerCount = parent ? _count.workerServices : (await this.parentCounts([category.slug])).get(category.slug) ?? 0;
    return {
      category: {
        ...category,
        workerCount,
        parent: parent ? { slug: parent.slug, name: parent.name } : null,
        subcategories: children.map(({ _count: childCount, ...child }) => ({ ...child, workerCount: childCount.workerServices })),
      },
    };
  }
}
