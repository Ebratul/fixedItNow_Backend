import { Controller, Delete, Get, Headers, HttpCode, Param, Put, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { CurrentAuth } from "../auth/decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { z } from "zod";
import { DOCUMENT_KINDS, type DocumentKindName } from "./document-crypto.js";
import { WorkerDocumentsService } from "./worker-documents.service.js";

const kindPipe = new ZodPipe(z.enum(DOCUMENT_KINDS));

/**
 * A worker's own identity documents. Upload only ever goes IN: nothing here returns file content
 * (not even to the owner). The body is the raw image (Content-Type image/jpeg|png|webp), at most 3 MB.
 */
@Controller("me/worker-profile/documents")
export class WorkerDocumentsController {
  constructor(private readonly documents: WorkerDocumentsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.documents.listOwn(auth);
  }

  @Throttle({ default: { limit: 12, ttl: 600_000 } })
  @Put(":kind")
  @HttpCode(200)
  upload(@CurrentAuth() auth: AuthContext, @Param("kind", kindPipe) kind: DocumentKindName, @Req() req: Request, @Headers("content-type") contentType: string | undefined) {
    return this.documents.upload(auth, kind, req.body, contentType);
  }

  @Delete(":kind")
  remove(@CurrentAuth() auth: AuthContext, @Param("kind", kindPipe) kind: DocumentKindName) {
    return this.documents.removeOwn(auth, kind);
  }
}
