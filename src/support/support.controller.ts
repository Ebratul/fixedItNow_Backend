import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { createTicketSchema, messageSchema, ticketListSchema, type CreateTicketInput } from "./support.schemas.js";
import { SupportService } from "./support.service.js";

/** The signed-in user's own support requests. Every query is scoped to the session user. */
@Controller("support/tickets")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Throttle({ default: { limit: 8, ttl: 3_600_000 } })
  @Post()
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createTicketSchema)) body: CreateTicketInput) {
    return this.support.create(auth, body);
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(ticketListSchema)) q: { status?: string; page: number; pageSize: number }) {
    return this.support.list(auth, q);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.support.get(auth, id);
  }

  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @Post(":id/messages")
  @HttpCode(201)
  reply(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(messageSchema)) body: { body: string }) {
    return this.support.reply(auth, id, body.body);
  }

  @Post(":id/close")
  @HttpCode(200)
  close(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.support.close(auth, id);
  }
}
