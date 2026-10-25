import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "./audit.service.js";

export type AuditQuery = {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
};

const rowSelect = {
  id: true,
  seq: true,
  action: true,
  targetType: true,
  targetId: true,
  metadata: true,
  createdAt: true,
  hash: true,
  actorId: true,
  actorSnapshot: true,
  actor: { select: { name: true, email: true } },
} satisfies Prisma.AuditLogSelect;

export const EXPORT_LIMIT = 5_000;

function where(q: AuditQuery): Prisma.AuditLogWhereInput {
  return {
    ...(q.actorId && { OR: [{ actorId: q.actorId }, { actorSnapshot: q.actorId }] }),
    ...(q.action && { action: q.action.endsWith("*") ? { startsWith: q.action.slice(0, -1) } : q.action }),
    ...(q.targetType && { targetType: q.targetType }),
    ...(q.targetId && { targetId: q.targetId }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } }),
    // free text matches the action name or the target id only: metadata is never searched
    ...(q.q && { OR: [{ action: { contains: q.q, mode: "insensitive" } }, { targetId: { contains: q.q, mode: "insensitive" } }] }),
  };
}

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: AuditQuery) {
    const filter = where(q);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where: filter }),
      this.prisma.auditLog.findMany({
        where: filter,
        orderBy: [{ seq: "desc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: rowSelect,
      }),
    ]);
    return {
      entries: rows.map(present),
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
    };
  }

  /** Distinct action names (bounded) for the filter dropdown. */
  async actions() {
    const rows = await this.prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" }, take: 300 });
    return { actions: rows.map((r) => r.action) };
  }

  /** CSV of at most EXPORT_LIMIT newest matching rows. Exporting is itself audited. */
  async exportCsv(admin: AuthContext, q: Omit<AuditQuery, "page" | "pageSize">) {
    const rows = await this.prisma.auditLog.findMany({ where: where({ ...q, page: 1, pageSize: 1 }), orderBy: { seq: "desc" }, take: EXPORT_LIMIT, select: rowSelect });
    await this.audit.record(this.prisma, {
      actorId: admin.userId,
      action: "audit.export",
      targetType: "AuditLog",
      targetId: "export",
      metadata: { rows: rows.length, filters: { action: q.action, targetType: q.targetType, from: q.from, to: q.to } },
    });
    const header = ["seq", "time", "actor", "action", "targetType", "targetId", "metadata", "hash"];
    const lines = rows.map((r) => [r.seq, r.createdAt.toISOString(), r.actor?.name ?? r.actorSnapshot ?? "system", r.action, r.targetType, r.targetId, r.metadata ? JSON.stringify(r.metadata) : "", r.hash].map(csvCell).join(","));
    return `${header.join(",")}\n${lines.join("\n")}\n`;
  }

  /**
   * Recomputes the whole hash chain inside PostgreSQL (the same function the insert trigger
   * uses) and checks that seq is gap-free and every row links to its predecessor.
   */
  async verify(admin: AuthContext) {
    const [row] = await this.prisma.$queryRaw<
      { checked: number; head_seq: number; head_hash: string | null; bad_hash_seq: number | null; bad_link_seq: number | null; bad_seq: number | null }[]
    >`
      WITH chk AS (
        SELECT a."seq", a."hash", a."prevHash",
               audit_log_hash(a) AS expected,
               lag(a."hash") OVER (ORDER BY a."seq") AS prev_hash_actual,
               lag(a."seq") OVER (ORDER BY a."seq") AS prev_seq
        FROM "audit_log" a
      )
      SELECT count(*)::int AS checked,
             COALESCE(max("seq"), 0)::int AS head_seq,
             (SELECT "hash" FROM "audit_log" ORDER BY "seq" DESC LIMIT 1) AS head_hash,
             min("seq") FILTER (WHERE "hash" <> expected)::int AS bad_hash_seq,
             min("seq") FILTER (WHERE "prevHash" <> COALESCE(prev_hash_actual, repeat('0', 64)))::int AS bad_link_seq,
             min("seq") FILTER (WHERE "seq" <> COALESCE(prev_seq, 0) + 1)::int AS bad_seq
      FROM chk`;
    const firstBad = [row!.bad_hash_seq, row!.bad_link_seq, row!.bad_seq].filter((v): v is number => v !== null);
    const result = {
      valid: firstBad.length === 0,
      checked: row!.checked,
      headSeq: row!.head_seq,
      headHash: row!.head_hash,
      firstInvalidSeq: firstBad.length ? Math.min(...firstBad) : null,
      problems: {
        contentChanged: row!.bad_hash_seq !== null,
        chainBroken: row!.bad_link_seq !== null,
        gapOrReorder: row!.bad_seq !== null,
      },
      checkedAt: new Date(),
    };
    // The check is logged AFTER it ran, so it is not part of what it verified.
    await this.audit.record(this.prisma, {
      actorId: admin.userId,
      action: "audit.verify",
      targetType: "AuditLog",
      targetId: "chain",
      metadata: { valid: result.valid, checked: result.checked, headSeq: result.headSeq, firstInvalidSeq: result.firstInvalidSeq },
    });
    return result;
  }
}

function present(r: Prisma.AuditLogGetPayload<{ select: typeof rowSelect }>) {
  return {
    id: r.id,
    seq: r.seq,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata,
    createdAt: r.createdAt,
    hash: r.hash,
    actor: r.actorId ? { id: r.actorId, name: r.actor?.name ?? null, email: r.actor?.email ?? null } : r.actorSnapshot ? { id: r.actorSnapshot, name: null, email: null, removed: true } : null,
  };
}

/** CSV cell with quoting and spreadsheet-formula neutralisation (a leading = + - @ would execute in Excel). */
export function csvCell(value: unknown): string {
  let text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value as number | boolean);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
