import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import type { AuthContext, WorkerContext } from "../auth/auth.types.js";
import {
  CurrentAuth,
  CurrentWorker,
  RequireApprovedWorker,
} from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { WorkerProfileService } from "./worker-profile.service.js";
import { workerDraftSchema, type WorkerDraftInput } from "./worker-profile.schema.js";

@Controller()
export class WorkerController {
  constructor(private readonly workers: WorkerProfileService) {}

  @Put("me/worker-profile")
  async saveDraft(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(workerDraftSchema)) body: WorkerDraftInput,
  ) {
    return { profile: await this.workers.saveDraft(auth, body) };
  }

  @Post("me/worker-profile/submit")
  @HttpCode(200)
  async submit(@CurrentAuth() auth: AuthContext) {
    return { profile: await this.workers.submit(auth) };
  }

  /**
   * Foundation for worker-only features (requests, availability, earnings in
   * later steps). Requires a SUBMITTED + VERIFIED profile.
   */
  @RequireApprovedWorker()
  @Get("worker/workspace")
  workspace(@CurrentWorker() worker: WorkerContext) {
    return { workerProfileId: worker.id, verificationStatus: worker.verificationStatus };
  }
}
