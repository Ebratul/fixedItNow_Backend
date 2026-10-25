import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { AuthIdPipe } from "../../common/id.pipe.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { UsersService } from "./users.service.js";

const listQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["USER", "ADMIN"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  kind: z.enum(["customer", "worker"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const suspensionBody = z.strictObject({ suspended: z.boolean(), reason: userText(3, 500, "Reason"), confirm: z.literal(true, "Confirmation is required") });
const adminAccessBody = z.strictObject({ roleId: z.uuid().nullable(), reason: userText(3, 500, "Reason"), confirm: z.literal(true, "Confirmation is required") });

@Controller("admin/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission("users.read")
  @Get()
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.users.list(q);
  }

  @RequirePermission("users.read")
  @Get(":id")
  get(@Param("id", new AuthIdPipe()) id: string) {
    return this.users.get(id);
  }

  @RequirePermission("users.suspend")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(":id/suspension")
  @HttpCode(200)
  async suspension(@CurrentAuth() auth: AuthContext, @Param("id", new AuthIdPipe()) id: string, @Body(new ZodPipe(suspensionBody)) body: z.infer<typeof suspensionBody>) {
    return { user: await this.users.setSuspension(auth, id, body.suspended, body.reason) };
  }

  @RequirePermission("admins.assign")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(":id/admin-access")
  @HttpCode(200)
  async adminAccess(@CurrentAuth() auth: AuthContext, @Param("id", new AuthIdPipe()) id: string, @Body(new ZodPipe(adminAccessBody)) body: z.infer<typeof adminAccessBody>) {
    return { user: await this.users.setAdminAccess(auth, id, body.roleId, body.reason) };
  }
}
