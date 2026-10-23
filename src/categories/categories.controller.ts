import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/decorators.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Controller("categories")
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Active service categories. Public; contains no user data. */
  @Public()
  @Get()
  async list() {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true },
    });
    return { categories };
  }
}
