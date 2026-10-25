import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  CONTENT_PATHS,
  historyQuery,
  proposalAdminQuery,
  proposalStatusSchema,
  reportDecisionSchema,
  reportListQuery,
  visibilitySchema,
  type ProposalStatusChange,
  type ReportDecision,
} from "./moderation.schemas.js";
import { ModerationService } from "./moderation.service.js";

const contentPath = z.enum(Object.keys(CONTENT_PATHS) as [keyof typeof CONTENT_PATHS, ...(keyof typeof CONTENT_PATHS)[]]);
const uuid = () => new ParseUUIDPipe();

/**
 * Every route needs a moderation permission. `RequirePermission` re-reads the role from the
 * database on each request (see AuthGuard), so nothing the client sends (hidden
 * buttons, ids, body fields) can grant access. Queues are paginated with a fixed
 * page size and expose public names only: no emails, no account ids.
 */
@RequirePermission("moderation.read")
@Controller("admin")
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get("moderation/overview")
  overview() {
    return this.moderation.overview();
  }

  @Get("moderation/history")
  history(@Query(new ZodPipe(historyQuery)) q: z.infer<typeof historyQuery>) {
    return this.moderation.history(q);
  }

  @Get("reports")
  reports(@Query(new ZodPipe(reportListQuery)) q: z.infer<typeof reportListQuery>) {
    return this.moderation.listReports(q);
  }

  @Get("reports/:id")
  report(@Param("id", uuid()) id: string) {
    return this.moderation.getReport(id);
  }

  @RequirePermission("moderation.manage")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("reports/:id/decision")
  @HttpCode(200)
  decide(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(reportDecisionSchema)) body: ReportDecision) {
    return this.moderation.decide(auth, id, body);
  }

  /** Hide or restore content directly (without a report). */
  @RequirePermission("moderation.manage")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("moderation/:type/:id/visibility")
  @HttpCode(200)
  visibility(
    @CurrentAuth() auth: AuthContext,
    @Param("type", new ZodPipe(contentPath)) type: keyof typeof CONTENT_PATHS,
    @Param("id", uuid()) id: string,
    @Body(new ZodPipe(visibilitySchema)) body: { hidden: boolean; reason: string },
  ) {
    return this.moderation.setVisibility(auth, CONTENT_PATHS[type], id, body.hidden, body.reason);
  }

  @Get("proposals")
  proposals(@Query(new ZodPipe(proposalAdminQuery)) q: z.infer<typeof proposalAdminQuery>) {
    return this.moderation.listProposals(q);
  }

  @RequirePermission("moderation.manage")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("proposals/:id/status")
  @HttpCode(200)
  proposalStatus(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(proposalStatusSchema)) body: ProposalStatusChange) {
    return this.moderation.setProposalStatus(auth, id, body);
  }
}
