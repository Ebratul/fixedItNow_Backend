import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { DashboardService } from "./dashboard.service.js";

const query = z.object({ days: z.coerce.number().int().refine((d) => [7, 14, 30, 90].includes(d), "Use 7, 14, 30 or 90").default(30) });

@RequirePermission("dashboard.view")
@Controller("admin/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(query)) q: z.infer<typeof query>) {
    return this.dashboard.get(auth, q.days);
  }
}
