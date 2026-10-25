import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { userText } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { CategoriesAdminService } from "./categories.service.js";

const slug = z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens").max(50);
const sortOrder = z.number().int().min(0).max(10_000);
const createBody = z.strictObject({
  name: userText(2, 60, "Name"),
  slug: slug.optional(),
  description: userText(1, 300, "Description"),
  parentId: z.uuid().nullable().optional(),
  sortOrder: sortOrder.optional(),
  isActive: z.boolean().optional(),
});
const patchBody = z
  .strictObject({
    name: userText(2, 60, "Name").optional(),
    description: userText(1, 300, "Description").optional(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
    parentId: z.uuid().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");
const orderBody = z.strictObject({ parentId: z.uuid().nullable(), ids: z.array(z.uuid()).min(1).max(100) });
const deleteBody = z.strictObject({ confirmSlug: z.string().min(1).max(60) });

@RequirePermission("catalog.read")
@Controller("admin/categories")
export class CategoriesAdminController {
  constructor(private readonly categories: CategoriesAdminService) {}

  @Get()
  tree() {
    return this.categories.tree();
  }

  @RequirePermission("catalog.manage")
  @Post()
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.categories.create(auth, body);
  }

  @RequirePermission("catalog.manage")
  @Put("order")
  reorder(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return this.categories.reorder(auth, body.parentId, body.ids);
  }

  @RequirePermission("catalog.manage")
  @Patch(":id")
  update(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(patchBody)) body: z.infer<typeof patchBody>) {
    return this.categories.update(auth, id, body);
  }

  @RequirePermission("catalog.manage")
  @Delete(":id")
  remove(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(deleteBody)) body: z.infer<typeof deleteBody>) {
    return this.categories.remove(auth, id, body.confirmSlug);
  }
}
