import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, OptionalAuth, Public } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { isValidSlug } from "../workers/slug.js";
import { AvailabilityService } from "./availability.service.js";
import {
  availabilityQuerySchema,
  availabilitySchema,
  timeOffSchema,
} from "./booking.schemas.js";

@Controller()
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
  ) {}

  /** The caller's OWN worker profile id (never taken from the request). */
  private async ownProfileId(auth: AuthContext): Promise<string> {
    const profile = await this.prisma.workerProfile.findUnique({ where: { userId: auth.userId }, select: { id: true } });
    if (!profile) throw new BadRequestException("Start your worker profile first");
    return profile.id;
  }

  @Get("me/availability")
  async mine(@CurrentAuth() auth: AuthContext) {
    return this.availability.getForWorker(await this.ownProfileId(auth));
  }

  @Put("me/availability")
  async replace(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(availabilitySchema)) body: { rules: { weekday: number; startMinute: number; endMinute: number }[] },
  ) {
    return this.availability.replaceRules(await this.ownProfileId(auth), body.rules);
  }

  @Post("me/time-off")
  async addTimeOff(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(timeOffSchema)) body: { startAt: Date; endAt: Date; note?: string | null },
  ) {
    return { timeOff: await this.availability.addTimeOff(await this.ownProfileId(auth), body.startAt, body.endAt, body.note) };
  }

  @Delete("me/time-off/:id")
  @HttpCode(200)
  async removeTimeOff(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.availability.removeTimeOff(await this.ownProfileId(auth), id);
  }

  /** Public: bookable start times. Customer-agnostic; reveals no booking details. (OptionalAuth only picks the data realm.) */
  @Public()
  @OptionalAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("workers/:slug/availability")
  async publicSlots(@Param("slug") slug: string, @Query(new ZodPipe(availabilityQuerySchema)) query: { from?: string; days: number; duration: number }) {
    const result = isValidSlug(slug) ? await this.availability.publicSlots(slug, query.from, query.days, query.duration) : undefined;
    if (!result) throw new NotFoundException("Professional not found");
    return result;
  }
}
