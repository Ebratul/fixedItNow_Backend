import { Controller, Get, Param, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { searchQuerySchema, type SearchQuery } from "./workers.schema.js";
import { WorkersService } from "./workers.service.js";

/** Public, read-only, user-agnostic (never returns per-viewer state). */
@Controller("workers")
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  search(@Query(new ZodPipe(searchQuerySchema)) query: SearchQuery) {
    return this.workers.search(query);
  }

  @Public()
  @Get(":slug")
  async profile(@Param("slug") slug: string) {
    return { worker: await this.workers.getBySlug(slug) };
  }
}
