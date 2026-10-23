import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth, RequireAdmin } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AdminService } from "./admin.service.js";

const listQuery = z.object({
  status: z
    .enum(["NOT_SUBMITTED", "PENDING", "VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"])
    .default("PENDING"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

const reviewBody = z
  .strictObject({
    decision: z.enum(["VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"]),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => body.decision === "VERIFIED" || Boolean(body.note), {
    path: ["note"],
    message: "A short reason is required",
  });

/** Every route here is admin-only, enforced server-side by AdminGuard. */
@RequireAdmin()
@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("workers")
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.admin.listWorkers(query.status, query.page);
  }

  @Post("workers/:id/verification")
  @HttpCode(200)
  async review(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(reviewBody)) body: z.infer<typeof reviewBody>,
  ) {
    return { worker: await this.admin.reviewWorker(auth, id, body.decision, body.note) };
  }
}
