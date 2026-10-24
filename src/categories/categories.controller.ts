import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { Public } from "../auth/decorators.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ELIGIBLE_WORKER } from "../workers/eligibility.js";

/**
 * Read-only on purpose. There is no create/update/delete endpoint: categories
 * are managed through the seed/migration process until an admin UI exists.
 */
@Controller("categories")
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  private readonly select = {
    slug: true,
    name: true,
    description: true,
    // Real count of publicly visible workers in this category.
    _count: { select: { workerServices: { where: { workerProfile: ELIGIBLE_WORKER } } } },
  } as const;

  /** Active categories with a COMPUTED count of listed professionals. */
  @Public()
  @Get()
  async list() {
    const rows = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: this.select,
    });
    return {
      categories: rows.map(({ _count, ...category }) => ({
        ...category,
        workerCount: _count.workerServices,
      })),
    };
  }

  @Public()
  @Get(":slug")
  async get(@Param("slug") slug: string) {
    const row = /^[a-z0-9-]{1,50}$/.test(slug)
      ? await this.prisma.serviceCategory.findFirst({
          where: { slug, isActive: true },
          select: this.select,
        })
      : null;
    if (!row) throw new NotFoundException("Category not found");
    const { _count, ...category } = row;
    return { category: { ...category, workerCount: _count.workerServices } };
  }
}
