import { Module } from "@nestjs/common";
import { WorkersService } from "../workers/workers.service.js";
import { AiClient } from "./ai-client.js";
import { AiInternalController } from "./ai-internal.controller.js";
import { AiRateLimiter } from "./ai-rate-limiter.js";
import { AiController } from "./ai.controller.js";
import { AiService } from "./ai.service.js";

@Module({
  controllers: [AiController, AiInternalController],
  providers: [AiService, AiClient, AiRateLimiter, WorkersService],
})
export class AiModule {}
