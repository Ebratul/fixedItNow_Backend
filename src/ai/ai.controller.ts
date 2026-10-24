import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CurrentAuth, Public } from "../auth/decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { chatRequestSchema, type ChatRequest } from "./ai.schemas.js";
import { AiService } from "./ai.service.js";

@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Whether the assistant is configured. Reveals nothing else. */
  @Public()
  @Get("status")
  status() {
    return this.ai.status();
  }

  /**
   * Natural-language service discovery. Needs a session: the paid model is not
   * offered to anonymous callers, who still have the normal search. The caller
   * is always the session user; the body has no user field (strict schema).
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post("chat")
  chat(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(chatRequestSchema)) body: ChatRequest) {
    return this.ai.chat(auth.userId, body);
  }
}
