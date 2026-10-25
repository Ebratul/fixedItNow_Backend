import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AnnouncementsReader } from "./announcements.reader.js";
import { NotificationsService } from "./notifications.service.js";

const listQuery = z.object({
  unread: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** The signed-in user's own notifications. Every query is scoped to the session user. */
@Controller()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly announcements: AnnouncementsReader,
  ) {}

  @Get("notifications")
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.notifications.list(auth.userId, q);
  }

  @Get("notifications/unread-count")
  async unreadCount(@CurrentAuth() auth: AuthContext) {
    return { unreadCount: await this.notifications.unreadCount(auth.userId) };
  }

  @Post("notifications/read-all")
  @HttpCode(200)
  readAll(@CurrentAuth() auth: AuthContext) {
    return this.notifications.markAllRead(auth.userId);
  }

  @Post("notifications/:id/read")
  @HttpCode(200)
  read(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.notifications.markRead(auth.userId, id);
  }

  /** Announcements for everyone (works without signing in). */
  @Public()
  @Get("announcements")
  async publicAnnouncements() {
    return { announcements: await this.announcements.active(["ALL"]) };
  }

  /** Announcements for this user: those for everyone plus those for their role. */
  @Get("me/announcements")
  async mine(@CurrentAuth() auth: AuthContext) {
    return { announcements: await this.announcements.active(await this.announcements.audiencesFor(auth.userId)) };
  }
}
