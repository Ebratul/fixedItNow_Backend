import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AuditService } from "../admin/audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { canReviewWorker } from "../auth/policies.js";
import { conflict, unprocessable } from "../bookings/domain-errors.js";
import { ENV, type Env } from "../config/env.js";
import { isUniqueViolation } from "../bookings/domain-errors.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SettingsService } from "../admin/settings/settings.service.js";
import {
  documentAad, MAX_DOCUMENT_BYTES, MIN_DOCUMENT_BYTES, open, seal, sha256Hex, sniffImage,
  type DocumentKindName,
} from "./document-crypto.js";

/** Both sides of the identity document are what "required" means when the setting is on. */
export const REQUIRED_KINDS: readonly DocumentKindName[] = ["NID_FRONT", "NID_BACK"];

@Injectable()
export class WorkerDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Whether both sides of the identity document are compulsory (the `workers.requireIdentityDocuments`
   * platform setting; optional by default). Never required while storage is unconfigured, because the
   * worker could not satisfy it.
   */
  async documentsRequired() {
    return this.env.documents !== null && (await this.settings.get("workers.requireIdentityDocuments"));
  }

  private key() {
    if (!this.env.documents) {
      throw new ServiceUnavailableException({ statusCode: 503, error: "Service Unavailable", code: "DOCUMENTS_NOT_CONFIGURED", message: "Identity document upload is not available right now." });
    }
    return this.env.documents;
  }

  /** The owner sees THAT a document exists, never its content or its hash. */
  async listOwn(auth: AuthContext) {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: auth.userId },
      select: { documents: { select: { kind: true, mimeType: true, sizeBytes: true, uploadedAt: true }, orderBy: { kind: "asc" } } },
    });
    return {
      storageAvailable: this.env.documents !== null,
      required: await this.documentsRequired(),
      requiredKinds: REQUIRED_KINDS,
      documents: profile?.documents ?? [],
    };
  }

  async upload(auth: AuthContext, kind: DocumentKindName, body: unknown, declaredType: string | undefined) {
    const { key, keyId } = this.key();
    if (!Buffer.isBuffer(body)) {
      throw unprocessable("UNSUPPORTED_MEDIA_TYPE", "Send the image itself as the request body (JPEG, PNG or WebP).");
    }
    if (body.length < MIN_DOCUMENT_BYTES) throw unprocessable("FILE_TOO_SMALL", "That file is too small to be a photo of a document.");
    if (body.length > MAX_DOCUMENT_BYTES) throw unprocessable("FILE_TOO_LARGE", `Files can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
    const type = sniffImage(body);
    if (!type) throw unprocessable("UNSUPPORTED_MEDIA_TYPE", "Only JPEG, PNG or WebP images are accepted.");
    if (declaredType && declaredType.split(";")[0]!.trim().toLowerCase() !== type) {
      throw unprocessable("MEDIA_TYPE_MISMATCH", "The file content does not match its declared type.");
    }

    const profile = await this.prisma.workerProfile.findUnique({ where: { userId: auth.userId }, select: { id: true, verificationStatus: true } });
    if (!profile) throw conflict("PROFILE_REQUIRED", "Save your worker profile first.");
    if (profile.verificationStatus === "VERIFIED") {
      throw conflict("ALREADY_VERIFIED", "Your profile is already verified. Contact support to change identity documents.");
    }

    const id = crypto.randomUUID();
    const sealed = seal(key, documentAad(id, profile.id, kind), body);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workerDocument.deleteMany({ where: { workerProfileId: profile.id, kind } });
        await tx.workerDocument.create({
          data: { id, workerProfileId: profile.id, kind, mimeType: type, sizeBytes: body.length, sha256: sha256Hex(body), keyId, iv: new Uint8Array(sealed.iv), authTag: new Uint8Array(sealed.authTag), ciphertext: new Uint8Array(sealed.ciphertext) },
        });
        await this.audit.record(tx, { actorId: auth.userId, action: "worker.document.upload", targetType: "WorkerProfile", targetId: profile.id, metadata: { kind, sizeBytes: body.length, mimeType: type } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("UPLOAD_IN_PROGRESS", "Another upload for this document is in progress. Try again.");
      throw error;
    }
    return this.listOwn(auth);
  }

  async removeOwn(auth: AuthContext, kind: DocumentKindName) {
    const profile = await this.prisma.workerProfile.findUnique({ where: { userId: auth.userId }, select: { id: true, verificationStatus: true } });
    if (!profile) throw new NotFoundException("Document not found");
    if (profile.verificationStatus === "VERIFIED") throw conflict("ALREADY_VERIFIED", "Your profile is already verified. Contact support to change identity documents.");
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.workerDocument.deleteMany({ where: { workerProfileId: profile.id, kind } });
      if (count === 0) throw new NotFoundException("Document not found");
      await this.audit.record(tx, { actorId: auth.userId, action: "worker.document.delete", targetType: "WorkerProfile", targetId: profile.id, metadata: { kind } });
    });
    return this.listOwn(auth);
  }

  /**
   * The ONLY place plaintext leaves the server. The caller must hold `workers.documents.view`
   * (checked by the route), may not be the profile's owner, and every successful view is audited
   * in the same transaction as the read, so there is no un-logged view.
   */
  async openForAdmin(admin: AuthContext, profileId: string, kind: DocumentKindName) {
    const { key } = this.key();
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.workerDocument.findFirst({
        where: { workerProfileId: profileId, kind },
        select: { id: true, mimeType: true, iv: true, authTag: true, ciphertext: true, workerProfile: { select: { userId: true } } },
      });
      if (!doc) throw new NotFoundException("Document not found");
      if (!canReviewWorker(admin, doc.workerProfile.userId)) throw new NotFoundException("Document not found");
      let data: Buffer;
      try {
        data = open(key, documentAad(doc.id, profileId, kind), { iv: Buffer.from(doc.iv), authTag: Buffer.from(doc.authTag), ciphertext: Buffer.from(doc.ciphertext) });
      } catch {
        throw new ServiceUnavailableException({ statusCode: 503, error: "Service Unavailable", code: "DOCUMENT_UNREADABLE", message: "This document could not be decrypted. It may have been sealed with a different key." });
      }
      await this.audit.record(tx, { actorId: admin.userId, action: "worker.document.view", targetType: "WorkerProfile", targetId: profileId, metadata: { kind, documentId: doc.id } });
      return { mimeType: doc.mimeType, data };
    });
  }
}
