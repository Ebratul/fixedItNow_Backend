import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { searchQuerySchema, type SearchQuery } from "../workers/workers.schema.js";
import { WorkersService } from "../workers/workers.service.js";
import { ServiceTokenGuard } from "./service-token.guard.js";

/**
 * The AI service's ONLY window onto marketplace data (FR-AI-05/06).
 *
 *  - Read-only and allowlisted: worker search and the category list.
 *  - Reuses the public search implementation and its `ELIGIBLE_WORKER` rule, so
 *    unpublished, unverified and suspended profiles can never appear, and the
 *    projection (`cardSelect`) cannot carry private columns.
 *  - Search arguments pass through the same strict Zod schema as `GET /workers`;
 *    no SQL, table or column name can be supplied.
 *  - Throttling is skipped because every call comes from the one AI host; the
 *    per-user limit is applied on `POST /ai/chat` instead.
 */
@Public()
@SkipThrottle()
@UseGuards(ServiceTokenGuard)
@Controller("internal/ai")
export class AiInternalController {
  constructor(
    private readonly workers: WorkersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("workers")
  search(@Query(new ZodPipe(searchQuerySchema)) query: SearchQuery) {
    // The AI never browses deep: first page, small pages only.
    return this.workers.search({ ...query, page: 1, pageSize: Math.min(query.pageSize, 24) });
  }

  @Get("categories")
  async categories() {
    const rows = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true },
    });
    return { categories: rows };
  }
}
