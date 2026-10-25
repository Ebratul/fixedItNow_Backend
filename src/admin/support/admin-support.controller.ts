import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "../../support/support.schemas.js";
import { AdminSupportService } from "./admin-support.service.js";

const listQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  assignee: z.union([z.enum(["me", "unassigned"]), z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const replyBody = z.strictObject({ body: userText(1, 4000, "Message"), internal: z.boolean().default(false) });
const patchBody = z
  .strictObject({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigneeId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullable().optional(),
    resolution: userText(5, 2000, "Resolution").optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");

@RequirePermission("support.read")
@Controller("admin/support")
export class AdminSupportController {
  constructor(private readonly support: AdminSupportService) {}

  @Get("tickets")
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.support.list(auth, q);
  }

  @Get("assignees")
  assignees() {
    return this.support.assignees();
  }

  @Get("tickets/:id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.support.get(auth, id);
  }

  @RequirePermission("support.manage")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("tickets/:id/messages")
  @HttpCode(201)
  reply(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(replyBody)) body: z.infer<typeof replyBody>) {
    return this.support.reply(auth, id, body.body, body.internal);
  }

  @RequirePermission("support.manage")
  @Patch("tickets/:id")
  update(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(patchBody)) body: z.infer<typeof patchBody>) {
    return this.support.update(auth, id, body);
  }
}
