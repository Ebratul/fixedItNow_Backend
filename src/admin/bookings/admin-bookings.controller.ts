import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { AdminBookingsService } from "./admin-bookings.service.js";

const STATUSES = ["REQUESTED", "QUOTED", "CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING", "COMPLETED", "CANCELLED", "DECLINED", "EXPIRED", "DISPUTED"] as const;
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

@RequirePermission("bookings.read")
@Controller("admin/bookings")
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get()
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.bookings.list(q);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.bookings.get(id);
  }
}
