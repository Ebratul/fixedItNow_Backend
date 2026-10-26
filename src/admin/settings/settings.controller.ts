import { Body, Controller, Get, HttpCode, Param, Put } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, Public, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { SettingsService } from "./settings.service.js";

const updateBody = z.strictObject({
  value: z.union([z.boolean(), z.number(), z.string()]),
  reason: userText(3, 300, "Reason"),
});

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Non-secret flags the web app needs before sign-in (maintenance banner, closed registration). */
  @Public()
  @Get("config/platform")
  publicConfig() {
    return this.settings.publicConfig();
  }

  @RequirePermission("settings.read")
  @Get("admin/settings")
  async list(@CurrentAuth() auth: AuthContext) {
    return { settings: await this.settings.list(auth) };
  }

  @RequirePermission("settings.manage")
  @Put("admin/settings/:key")
  @HttpCode(200)
  async update(@CurrentAuth() auth: AuthContext, @Param("key") key: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return { setting: await this.settings.update(auth, key, body.value, body.reason) };
  }
}
