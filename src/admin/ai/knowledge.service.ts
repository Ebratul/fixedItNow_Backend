import { BadGatewayException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AiClient, AiClientError } from "../../ai/ai-client.js";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, isUniqueViolation, unprocessable } from "../../bookings/domain-errors.js";
import { ENV, type Env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { KnowledgeStatus } from "../../generated/prisma/enums.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { knowledgeDigest } from "./knowledge.digest.js";

export type KnowledgeInput = { slug: string; title: string; url: string; body: string };
const MIN_PUBLISH_CHARS = 50;

/** DRAFT <-> PUBLISHED, anything -> ARCHIVED, ARCHIVED -> DRAFT. Nothing reaches the assistant except PUBLISHED. */
const TRANSITIONS: Record<KnowledgeStatus, readonly KnowledgeStatus[]> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

const listSelect = { id: true, slug: true, title: true, url: true, status: true, version: true, updatedAt: true, publishedAt: true } satisfies Prisma.KnowledgeDocumentSelect;

@Injectable()
export class KnowledgeAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiClient,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(q: { status?: KnowledgeStatus; q?: string }) {
    const term = q.q?.trim();
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: { ...(q.status && { status: q.status }), ...(term && { OR: [{ title: { contains: term, mode: "insensitive" } }, { slug: { contains: term, mode: "insensitive" } }, { body: { contains: term, mode: "insensitive" } }] }) },
      orderBy: [{ status: "asc" }, { slug: "asc" }],
      take: 200,
      select: { ...listSelect, body: true },
    });
    return { documents: rows.map(({ body, ...d }) => ({ ...d, characters: body.length, allowedNext: TRANSITIONS[d.status] })) };
  }

  async get(id: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
      select: { ...listSelect, body: true, revisions: { orderBy: { version: "desc" }, take: 30, select: { version: true, title: true, createdAt: true } } },
    });
    if (!doc) throw new NotFoundException("Document not found");
    return { document: { ...doc, allowedNext: TRANSITIONS[doc.status] } };
  }

  async revision(id: string, version: number) {
    const rev = await this.prisma.knowledgeRevision.findUnique({ where: { documentId_version: { documentId: id, version } }, select: { version: true, title: true, body: true, createdAt: true } });
    if (!rev) throw new NotFoundException("Revision not found");
    return { revision: rev };
  }

  async create(admin: AuthContext, input: KnowledgeInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const doc = await tx.knowledgeDocument.create({
          data: { ...input, updatedById: admin.userId, revisions: { create: { version: 1, title: input.title, body: input.body, createdById: admin.userId } } },
          select: { ...listSelect, body: true },
        });
        await this.audit.record(tx, { actorId: admin.userId, action: "ai.knowledge.create", targetType: "KnowledgeDocument", targetId: doc.id, metadata: { slug: doc.slug, title: doc.title, characters: doc.body.length } });
        return { document: { ...doc, allowedNext: TRANSITIONS[doc.status] } };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "A document with that slug already exists");
      throw error;
    }
  }

  /** Edits bump the version and keep the previous text as a revision. A published document stays published; the change reaches the assistant at the next sync. */
  async update(admin: AuthContext, id: string, patch: Partial<Pick<KnowledgeInput, "title" | "url" | "body">>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.knowledgeDocument.findUnique({ where: { id }, select: { ...listSelect, body: true } });
      if (!before) throw new NotFoundException("Document not found");
      if (before.status === "ARCHIVED") throw conflict("ARCHIVED", "Restore an archived document to draft before editing it");
      if (before.status === "PUBLISHED" && patch.body !== undefined && patch.body.length < MIN_PUBLISH_CHARS) {
        throw unprocessable("TOO_SHORT", `A published document needs at least ${MIN_PUBLISH_CHARS} characters`);
      }
      const changed = (["title", "url", "body"] as const).filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
      if (changed.length === 0) throw conflict("NO_CHANGE", "Nothing to change");
      const version = before.version + 1;
      const doc = await tx.knowledgeDocument.update({
        where: { id },
        data: { ...Object.fromEntries(changed.map((k) => [k, patch[k]])), version, updatedById: admin.userId, revisions: { create: { version, title: patch.title ?? before.title, body: patch.body ?? before.body, createdById: admin.userId } } },
        select: { ...listSelect, body: true },
      });
      await this.audit.record(tx, { actorId: admin.userId, action: "ai.knowledge.update", targetType: "KnowledgeDocument", targetId: id, metadata: { slug: doc.slug, fields: changed, version, status: doc.status } });
      return { document: { ...doc, allowedNext: TRANSITIONS[doc.status] } };
    });
  }

  async revert(admin: AuthContext, id: string, toVersion: number) {
    const rev = await this.prisma.knowledgeRevision.findUnique({ where: { documentId_version: { documentId: id, version: toVersion } } });
    if (!rev) throw new NotFoundException("Revision not found");
    const result = await this.update(admin, id, { title: rev.title, body: rev.body });
    await this.audit.record(this.prisma, { actorId: admin.userId, action: "ai.knowledge.revert", targetType: "KnowledgeDocument", targetId: id, metadata: { toVersion } });
    return result;
  }

  async setStatus(admin: AuthContext, id: string, to: KnowledgeStatus) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.knowledgeDocument.findUnique({ where: { id }, select: { ...listSelect, body: true } });
      if (!doc) throw new NotFoundException("Document not found");
      if (!TRANSITIONS[doc.status].includes(to)) throw conflict("INVALID_TRANSITION", `A ${doc.status.toLowerCase()} document cannot become ${to.toLowerCase()}`);
      if (to === "PUBLISHED" && doc.body.length < MIN_PUBLISH_CHARS) throw unprocessable("TOO_SHORT", `A document needs at least ${MIN_PUBLISH_CHARS} characters before it can be published`);
      const { count } = await tx.knowledgeDocument.updateMany({ where: { id, status: doc.status }, data: { status: to, publishedAt: to === "PUBLISHED" ? new Date() : null, updatedById: admin.userId } });
      if (count === 0) throw conflict("STALE_DOCUMENT", "This document just changed. Refresh and try again.");
      await this.audit.record(tx, { actorId: admin.userId, action: `ai.knowledge.${to === "PUBLISHED" ? "publish" : to === "ARCHIVED" ? "archive" : doc.status === "ARCHIVED" ? "restore" : "unpublish"}`, targetType: "KnowledgeDocument", targetId: id, metadata: { slug: doc.slug, from: doc.status, to } });
    }).then(() => this.get(id));
  }

  /** Digest of exactly what GET /internal/ai/knowledge serves (PUBLISHED documents). */
  private async publishedDigest() {
    const rows = await this.prisma.knowledgeDocument.findMany({ where: { status: "PUBLISHED" }, select: { slug: true, title: true, url: true, body: true } });
    return { digest: knowledgeDigest(rows.map((r) => ({ id: r.slug, title: r.title, url: r.url, body: r.body }))), count: rows.length };
  }

  async status() {
    const [published, counts, lastSync, aiHealth, knowledge, enabled] = await Promise.all([
      this.publishedDigest(),
      this.prisma.knowledgeDocument.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.auditLog.findFirst({ where: { action: { in: ["ai.knowledge.sync", "ai.knowledge.sync_failed"] } }, orderBy: { seq: "desc" }, select: { action: true, createdAt: true, metadata: true, actor: { select: { name: true } } } }),
      this.ai.health(),
      this.ai.knowledgeStatus(),
      this.settings.get("ai.assistantEnabled"),
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    return {
      service: {
        configured: this.env.ai !== null,
        reachable: aiHealth !== null,
        llm: aiHealth?.llm ?? null,
        assistantEnabled: enabled,
      },
      knowledge: {
        published: byStatus.PUBLISHED ?? 0,
        draft: byStatus.DRAFT ?? 0,
        archived: byStatus.ARCHIVED ?? 0,
        expectedDigest: published.digest,
        running: knowledge ? { source: knowledge.source, configuredSource: knowledge.configuredSource, documents: knowledge.documents, chunks: knowledge.chunks, digest: knowledge.digest } : null,
        // "in sync" is only claimed when the running index was built from the API AND matches the published content
        inSync: knowledge !== null && knowledge.source === "api" && knowledge.digest === published.digest,
        lastSync: lastSync ? { ok: lastSync.action === "ai.knowledge.sync", at: lastSync.createdAt, by: lastSync.actor?.name ?? "system", detail: lastSync.metadata } : null,
      },
    };
  }

  /** Make the running assistant use the currently published documents. Needs `confirm`: it changes live answers. */
  async sync(admin: AuthContext) {
    if (!this.env.ai) throw unprocessable("AI_NOT_CONFIGURED", "The AI service is not configured in this environment");
    const expected = await this.publishedDigest();
    try {
      const running = await this.ai.reloadKnowledge();
      const inSync = running.source === "api" && running.digest === expected.digest;
      await this.audit.record(this.prisma, { actorId: admin.userId, action: "ai.knowledge.sync", targetType: "AiService", targetId: "knowledge", metadata: { publishedDocuments: expected.count, documents: running.documents, chunks: running.chunks, source: running.source, inSync } });
      return { synced: true, inSync, source: running.source, documents: running.documents, chunks: running.chunks, hint: running.source === "api" ? null : "The AI service is configured to read bundled files (AI_KNOWLEDGE_SOURCE=files), so published documents do not reach it. See docs/ADMIN.md." };
    } catch (error) {
      const reason = error instanceof AiClientError ? error.kind : "error";
      await this.audit.record(this.prisma, { actorId: admin.userId, action: "ai.knowledge.sync_failed", targetType: "AiService", targetId: "knowledge", metadata: { reason, status: error instanceof AiClientError ? error.status : undefined } });
      throw new BadGatewayException({ statusCode: 502, error: "Bad Gateway", code: "AI_SYNC_FAILED", message: "The AI service could not rebuild its knowledge. The previous knowledge is still in use." });
    }
  }
}
