import { Module } from "@nestjs/common";
import { ModerationController } from "../moderation/moderation.controller.js";
import { ModerationService } from "../moderation/moderation.service.js";
import { ProposalsController } from "../proposals/proposals.controller.js";
import { ProposalsService } from "../proposals/proposals.service.js";
import { CommunityController } from "./community.controller.js";
import { CommunityService } from "./community.service.js";
import { ReportsService } from "./reports.service.js";

/** Community posts/comments/reactions, feature proposals, reports, and the admin moderation API. */
@Module({
  controllers: [CommunityController, ProposalsController, ModerationController],
  providers: [CommunityService, ReportsService, ProposalsService, ModerationService],
})
export class CommunityModule {}
