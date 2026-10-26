import { Controller, Get, Param, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { OptionalAuth, Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { searchQuerySchema, type SearchQuery } from "./workers.schema.js";
import { WorkersService } from "./workers.service.js";

/**
 * Public, read-only, user-agnostic (never returns per-viewer state). OptionalAuth only chooses the data realm: demo
 * visitors browse the demo professionals, everyone else the real ones (docs/DEMO.md).
 */
@Controller("workers")
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Public()
  @OptionalAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  search(@Query(new ZodPipe(searchQuerySchema)) query: SearchQuery) {
    return this.workers.search(query);
  }

  @Public()
  @OptionalAuth()
  @Get(":slug")
  async profile(@Param("slug") slug: string) {
    return { worker: await this.workers.getBySlug(slug) };
  }
}
