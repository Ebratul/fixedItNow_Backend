import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import type { AuthContext } from "../../auth/auth.types.js";
import { CurrentAuth, RequirePermission } from "../../auth/decorators.js";
import { FORBIDDEN_TEXT } from "../../common/user-text.js";
import { ZodPipe } from "../../common/zod.pipe.js";
import { DOCUMENT_KINDS, type DocumentKindName } from "../../worker/document-crypto.js";
import { WorkerDocumentsService } from "../../worker/worker-documents.service.js";
import { AdminWorkersService } from "./admin-workers.service.js";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const listQuery = z.object({
  status: z.enum(["ALL", "NOT_SUBMITTED", "PENDING", "VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"]).default("PENDING"),
  q: z.string().trim().min(1).max(100).optional(),
  published: bool.optional(),
  suspended: bool.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});

const note = z.string().trim().min(1).max(500).refine((v) => !FORBIDDEN_TEXT.test(v), "Contains unsupported characters");
const reviewBody = z
  .strictObject({ decision: z.enum(["VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"]), note: note.optional() })
  .refine((body) => body.decision === "VERIFIED" || Boolean(body.note), { path: ["note"], message: "A short reason is required" });
const suspensionBody = z
  .strictObject({ suspended: z.boolean(), reason: note.optional() })
  .refine((body) => !body.suspended || Boolean(body.reason), { path: ["reason"], message: "A short reason is required to suspend" });

@RequirePermission("workers.read")
@Controller("admin/workers")
export class AdminWorkersController {
  constructor(
    private readonly workers: AdminWorkersService,
    private readonly documents: WorkerDocumentsService,
  ) {}

  @Get()
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.workers.list(query);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.workers.get(auth, id);
  }

  @RequirePermission("workers.review")
  @Post(":id/verification")
  @HttpCode(200)
  async review(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(reviewBody)) body: z.infer<typeof reviewBody>) {
    return { worker: await this.workers.review(auth, id, body.decision, body.note) };
  }

  @RequirePermission("workers.suspend")
  @Post(":id/suspension")
  @HttpCode(200)
  async suspension(@CurrentAuth() auth: AuthContext, @Param("id", new ParseUUIDPipe()) id: string, @Body(new ZodPipe(suspensionBody)) body: z.infer<typeof suspensionBody>) {
    return { worker: await this.workers.setSuspension(auth, id, body.suspended, body.reason) };
  }

  /**
   * Private identity image. Needs `workers.documents.view`; each view is audited; the response is
   * never cacheable, cannot be sniffed into another type, and is sandboxed.
   */
  @RequirePermission("workers.documents.view")
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get(":id/documents/:kind")
  async document(
    @CurrentAuth() auth: AuthContext,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("kind", new ZodPipe(z.enum(DOCUMENT_KINDS))) kind: DocumentKindName,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { mimeType, data } = await this.documents.openForAdmin(auth, id, kind);
    res.set({
      "Content-Type": mimeType,
      "Content-Disposition": 'inline; filename="identity-document"',
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex, noarchive",
    });
    return new StreamableFile(data);
  }
}
