import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { createProposalSchema, proposalListQuery, type ProposalStatusName } from "./proposals.schemas.js";
import { ProposalsService } from "./proposals.service.js";

/** Session required for everything. Status, votes and author can never be sent by a client. */
@Controller("feature-proposals")
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(proposalListQuery)) q: { sort: "top" | "new"; status?: ProposalStatusName; page: number; pageSize: number },
  ) {
    return this.proposals.list(auth, q);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createProposalSchema)) body: { title: string; description: string }) {
    return this.proposals.create(auth, body);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.proposals.get(auth, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(":id/vote")
  @HttpCode(200)
  vote(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.proposals.vote(auth, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Delete(":id/vote")
  @HttpCode(200)
  withdraw(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.proposals.withdraw(auth, id);
  }
}
