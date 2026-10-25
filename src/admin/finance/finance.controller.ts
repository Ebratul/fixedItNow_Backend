import { Controller, Get, Header, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { FinanceService, MAX_RANGE_DAYS } from "./finance.service.js";

const DAY = 86_400_000;
/** Default range: the last 30 days. A range is at most a year, so reports stay bounded. */
const rangeQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    rateBps: z.coerce.number().int().min(0).max(5000).optional(),
  })
  .transform((q, ctx) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY);
    if (from >= to) ctx.addIssue({ code: "custom", path: ["from"], message: "'from' must be before 'to'" });
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) ctx.addIssue({ code: "custom", path: ["to"], message: `A report can span at most ${MAX_RANGE_DAYS} days` });
    return { range: { from, to }, rateBps: q.rateBps };
  });

@RequirePermission("finance.reports")
@Controller("admin/finance")
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("summary")
  summary(@Query(new ZodPipe(rangeQuery)) q: z.output<typeof rangeQuery>) {
    return this.finance.summary(q.range);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("commission")
  commission(@Query(new ZodPipe(rangeQuery)) q: z.output<typeof rangeQuery>) {
    return this.finance.commission(q.range, q.rateBps);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get("commission/export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="commission-report.csv"')
  @Header("Cache-Control", "no-store")
  export(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(rangeQuery)) q: z.output<typeof rangeQuery>) {
    return this.finance.commissionCsv(auth, q.range, q.rateBps);
  }
}
