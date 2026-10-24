import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { paginationSchema } from "../workers/workers.schema.js";
import { FavoritesService } from "./favorites.service.js";

/**
 * Private to the caller. No endpoint takes a user id; the owner is always the
 * authenticated session. (Routes live under /me, so they are authenticated by
 * the global default-deny guard.)
 */
@Controller("me/favorites")
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(paginationSchema)) query: { page: number; pageSize: number },
  ) {
    return this.favorites.list(auth, query.page, query.pageSize);
  }

  @Get("ids")
  ids(@CurrentAuth() auth: AuthContext) {
    return this.favorites.ids(auth);
  }

  @Put(":workerId")
  @HttpCode(200)
  add(@CurrentAuth() auth: AuthContext, @Param("workerId", new ParseUUIDPipe()) workerId: string) {
    return this.favorites.add(auth, workerId);
  }

  @Delete(":workerId")
  @HttpCode(200)
  remove(@CurrentAuth() auth: AuthContext, @Param("workerId", new ParseUUIDPipe()) workerId: string) {
    return this.favorites.remove(auth, workerId);
  }
}
