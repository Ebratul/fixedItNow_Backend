import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { ALL_PERMISSIONS, type Permission } from "../permissions.js";
import { RolesService } from "./roles.service.js";

// "*" is intentionally not accepted here: only the system super_admin role has it.
const permissionEnum = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);
const permissions = z.array(permissionEnum).min(1, "Choose at least one permission").max(ALL_PERMISSIONS.length);

const createBody = z.strictObject({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, "Use lowercase letters, digits and underscores, starting with a letter"),
  name: userText(2, 60, "Name"),
  description: userText(1, 300, "Description"),
  permissions,
});
const updateBody = z
  .strictObject({ name: userText(2, 60, "Name").optional(), description: userText(1, 300, "Description").optional(), permissions: permissions.optional() })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");
const deleteBody = z.strictObject({ confirmKey: z.string().min(1).max(60) });

@RequirePermission("roles.read")
@Controller("admin/roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get("permissions")
  catalog() {
    return this.roles.catalog();
  }

  @Get()
  list() {
    return this.roles.list();
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.roles.get(id);
  }

  @RequirePermission("roles.manage")
  @Post()
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.roles.create(auth, body);
  }

  @RequirePermission("roles.manage")
  @Patch(":id")
  update(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.roles.update(auth, id, body);
  }

  @RequirePermission("roles.manage")
  @Delete(":id")
  remove(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(deleteBody)) body: z.infer<typeof deleteBody>) {
    return this.roles.remove(auth, id, body.confirmKey);
  }
}
