import { Controller, Get, Header, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { AuditQueryService } from "./audit-query.service.js";

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const filters = {
  actorId: optionalText(64),
  action: z.string().trim().regex(/^[a-z][a-z0-9_.]*\*?$/, "Use an action name like user.suspend or user.*").max(80).optional(),
  targetType: z.string().trim().regex(/^[A-Za-z]+$/).max(40).optional(),
  targetId: optionalText(100),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: optionalText(80),
};
const listQuery = z.object({
  ...filters,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const exportQuery = z.object(filters);

@Controller("admin/audit")
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @RequirePermission("audit.read")
  @Get()
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.audit.list(q);
  }

  @RequirePermission("audit.read")
  @Get("actions")
  actions() {
    return this.audit.actions();
  }

  @RequirePermission("audit.read")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get("export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="audit-log.csv"')
  @Header("Cache-Control", "no-store")
  export(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(exportQuery)) q: z.infer<typeof exportQuery>) {
    return this.audit.exportCsv(auth, q);
  }

  @RequirePermission("audit.verify")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Get("verify")
  verify(@CurrentAuth() auth: AuthContext) {
    return this.audit.verify(auth);
  }
}
