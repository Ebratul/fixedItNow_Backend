import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { AnnouncementsAdminService } from "./announcements.service.js";

const audience = z.enum(["ALL", "CUSTOMERS", "WORKERS"]);
const severity = z.enum(["INFO", "WARNING", "CRITICAL"]);
const when = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const fields = {
  title: userText(3, 120, "Title"),
  body: userText(1, 2000, "Message"),
  audience,
  severity,
  startsAt: when.nullable().optional(),
  endsAt: when.nullable().optional(),
};
const createBody = z.strictObject({ ...fields, audience: audience.default("ALL"), severity: severity.default("INFO") });
const patchBody = z.strictObject({ title: fields.title.optional(), body: fields.body.optional(), audience: audience.optional(), severity: severity.optional(), startsAt: fields.startsAt, endsAt: fields.endsAt }).refine((b) => Object.keys(b).length > 0, "Nothing to change");
const confirmBody = z.strictObject({ confirm: z.literal(true, "Confirmation is required") });
const listQuery = z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(), page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) });
const sendBody = z.strictObject({
  userId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  title: userText(3, 120, "Title"),
  body: userText(1, 1000, "Message"),
  // In-app paths only, like the database constraint: "/account/support", never "https://..." or "//host".
  link: z.string().regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/, "Use an in-app path such as /account").max(200).nullable().optional(),
});

@RequirePermission("notifications.manage")
@Controller("admin")
export class AnnouncementsAdminController {
  constructor(private readonly announcements: AnnouncementsAdminService) {}

  @Get("announcements")
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.announcements.list(q);
  }

  @Post("announcements")
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.announcements.create(auth, body);
  }

  @Patch("announcements/:id")
  update(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(patchBody)) body: z.infer<typeof patchBody>) {
    return this.announcements.update(auth, id, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("announcements/:id/publish")
  @HttpCode(200)
  publish(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(confirmBody)) _b: unknown) {
    return this.announcements.publish(auth, id);
  }

  @Post("announcements/:id/archive")
  @HttpCode(200)
  archive(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.announcements.archive(auth, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("notifications")
  @HttpCode(201)
  send(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(sendBody)) body: z.infer<typeof sendBody>) {
    return this.announcements.sendToUser(auth, body);
  }
}
