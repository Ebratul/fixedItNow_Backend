import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { CONTENT_PATHS } from "../../moderation/moderation.schemas.js";
import { ContentService } from "./content.service.js";

const typeParam = z.enum(Object.keys(CONTENT_PATHS) as [keyof typeof CONTENT_PATHS, ...(keyof typeof CONTENT_PATHS)[]]);
const query = z.object({
  status: z.enum(["VISIBLE", "HIDDEN", "DELETED"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  reported: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});

@RequirePermission("moderation.read")
@Controller("admin/content")
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get(":type")
  list(@Param("type", new ZodPipe(typeParam)) type: keyof typeof CONTENT_PATHS, @Query(new ZodPipe(query)) q: z.infer<typeof query>) {
    return this.content.list({ ...q, type: CONTENT_PATHS[type] });
  }
}
