import { Body, Controller, Get, Put } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import {
  customerProfileSchema,
  type CustomerProfileInput,
} from "./customer-profile.schema.js";
import { MeService } from "./me.service.js";

/**
 * "Me" endpoints take no user id: the subject is always the authenticated
 * caller, which makes IDOR on these resources structurally impossible.
 */
@Controller("me")
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.me.getMe(auth);
  }

  @Put("customer-profile")
  async putCustomerProfile(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(customerProfileSchema)) body: CustomerProfileInput,
  ) {
    return { profile: await this.me.upsertCustomerProfile(auth, body) };
  }
}
