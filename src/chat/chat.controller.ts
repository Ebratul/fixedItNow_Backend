import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { listMessagesSchema, sendMessageSchema, type ListMessagesQuery, type SendMessageInput } from "./chat.schemas.js";
import { ChatService } from "./chat.service.js";

/**
 * Private, booking-linked chat. Default-deny applies (a session is required); then the
 * service checks that the caller is the booking's customer or its assigned professional.
 * Nothing here is reachable from a public profile, search, or admin endpoint.
 */
@Controller("bookings/:id/chat")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  thread(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Query(new ZodPipe(listMessagesSchema)) query: ListMessagesQuery) {
    return this.chat.thread(auth, id, query);
  }

  @Post("messages")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async send(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(sendMessageSchema)) body: SendMessageInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, ...result } = await this.chat.send(auth, id, body);
    res.status(created ? 201 : 200);
    return result;
  }
}
