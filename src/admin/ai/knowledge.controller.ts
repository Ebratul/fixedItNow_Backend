import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { KnowledgeAdminService } from "./knowledge.service.js";

const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and hyphens (up to 40 characters)");
const url = z.string().trim().regex(/^\/[a-z0-9/-]{0,99}$/, "Use an in-app path such as /help");
const title = userText(3, 120, "Title");
const body = userText(20, 20_000, "Text");
const createBody = z.strictObject({ slug, title, url, body });
const patchBody = z.strictObject({ title: title.optional(), url: url.optional(), body: body.optional() }).refine((b) => Object.keys(b).length > 0, "Nothing to change");
const statusBody = z.strictObject({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]), confirm: z.literal(true).optional() })
  .refine((b) => b.status !== "PUBLISHED" || b.confirm === true, { path: ["confirm"], message: "Confirmation is required to publish" });
const revertBody = z.strictObject({ version: z.number().int().min(1).max(100_000) });
const confirmBody = z.strictObject({ confirm: z.literal(true, "Confirmation is required") });
const listQuery = z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(), q: z.string().trim().min(1).max(100).optional() });

@RequirePermission("ai.read")
@Controller("admin/ai")
export class KnowledgeAdminController {
  constructor(private readonly knowledge: KnowledgeAdminService) {}

  @Get("status")
  status() {
    return this.knowledge.status();
  }

  @Get("knowledge")
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.knowledge.list(q);
  }

  @Get("knowledge/:id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.knowledge.get(id);
  }

  @Get("knowledge/:id/revisions/:version")
  revision(@Param("id", new ParseUUIDPipe()) id: string, @Param("version", new ParseIntPipe()) version: number) {
    return this.knowledge.revision(id, version);
  }

  @RequirePermission("ai.manage")
  @Post("knowledge")
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createBody)) b: z.infer<typeof createBody>) {
    return this.knowledge.create(auth, b);
  }

  @RequirePermission("ai.manage")
  @Patch("knowledge/:id")
  update(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(patchBody)) b: z.infer<typeof patchBody>) {
    return this.knowledge.update(auth, id, b);
  }

  @RequirePermission("ai.manage")
  @Post("knowledge/:id/status")
  @HttpCode(200)
  setStatus(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(statusBody)) b: z.infer<typeof statusBody>) {
    return this.knowledge.setStatus(auth, id, b.status);
  }

  @RequirePermission("ai.manage")
  @Post("knowledge/:id/revert")
  @HttpCode(200)
  revert(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(revertBody)) b: z.infer<typeof revertBody>) {
    return this.knowledge.revert(auth, id, b.version);
  }

  @RequirePermission("ai.manage")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post("sync")
  @HttpCode(200)
  sync(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(confirmBody)) _b: unknown) {
    return this.knowledge.sync(auth);
  }
}
