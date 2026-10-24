import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  REACTION_TYPES,
  commentListQuery,
  commentSchema,
  communityReportSchema,
  createPostSchema,
  postListQuery,
  reactionSchema,
  reportBodySchema,
  updatePostSchema,
  type CommunityReport,
  type ReportBody,
} from "./community.schemas.js";
import { CommunityService } from "./community.service.js";
import { ReportsService } from "./reports.service.js";

const uuid = () => new ParseUUIDPipe();
type Page = { page: number; pageSize: number };

/**
 * Every route needs a session (the community is a signed-in space: no
 * per-viewer data is ever cacheable, and names are not exposed to anonymous
 * scrapers). Identity always comes from the session; bodies are strict.
 */
@Controller()
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly reports: ReportsService,
  ) {}

  @Get("community/posts")
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(postListQuery)) q: Page & { scope: "all" | "mine" }) {
    return this.community.listPosts(auth, q.scope, q.page, q.pageSize);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("community/posts")
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createPostSchema)) body: { title: string; body: string }) {
    return this.community.createPost(auth, body);
  }

  @Get("community/posts/:id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.community.getPost(auth, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch("community/posts/:id")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Body(new ZodPipe(updatePostSchema)) body: { title?: string; body?: string },
  ) {
    return this.community.updatePost(auth, id, body);
  }

  @Delete("community/posts/:id")
  @HttpCode(200)
  remove(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.community.deletePost(auth, id);
  }

  @Get("community/posts/:id/comments")
  comments(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Query(new ZodPipe(commentListQuery)) q: Page) {
    return this.community.listComments(auth, id, q.page, q.pageSize);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("community/posts/:id/comments")
  comment(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(commentSchema)) body: { body: string }) {
    return this.community.createComment(auth, id, body.body);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch("community/comments/:id")
  editComment(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(commentSchema)) body: { body: string }) {
    return this.community.updateComment(auth, id, body.body);
  }

  @Delete("community/comments/:id")
  @HttpCode(200)
  removeComment(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string) {
    return this.community.deleteComment(auth, id);
  }

  /** Idempotent: 200 with the same body however many times it is repeated. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("community/posts/:id/reactions")
  @HttpCode(200)
  react(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(reactionSchema)) body: { type: "LIKE" }) {
    return this.community.react(auth, id, body.type);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Delete("community/posts/:id/reactions/:type")
  @HttpCode(200)
  unreact(
    @CurrentAuth() auth: AuthContext,
    @Param("id", uuid()) id: string,
    @Param("type", new ParseEnumPipe(Object.fromEntries(REACTION_TYPES.map((t) => [t, t])))) type: "LIKE",
  ) {
    return this.community.unreact(auth, id, type);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("community/reports")
  report(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(communityReportSchema)) body: CommunityReport) {
    return this.reports.create(auth, { type: body.targetType, id: body.targetId }, body);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("reviews/:id/report")
  reportReview(@CurrentAuth() auth: AuthContext, @Param("id", uuid()) id: string, @Body(new ZodPipe(reportBodySchema)) body: ReportBody) {
    return this.reports.create(auth, { type: "REVIEW", id }, body);
  }
}
