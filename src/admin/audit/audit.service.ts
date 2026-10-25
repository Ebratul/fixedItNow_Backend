import { Injectable } from "@nestjs/common";
import { currentRequestId } from "../../common/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { sanitizeAuditMetadata } from "./audit-sanitize.js";

type Db = Prisma.TransactionClient | PrismaService;

export type AuditEntry = {
  actorId: string | null;
  /** dotted, past-tense-free verb: "user.suspend", "role.update", ... */
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
};

/**
 * The one way admin-panel code writes the audit trail. Call it with the SAME transaction client as
 * the change it records, so a change and its audit row commit or roll back together. The hash
 * chain (seq / prevHash / hash) is added by a database trigger, not here.
 */
@Injectable()
export class AuditService {
  record(db: Db, entry: AuditEntry) {
    const requestId = currentRequestId();
    const metadata = sanitizeAuditMetadata({ ...entry.metadata, ...(requestId && { requestId }) });
    return db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ...(metadata !== null && { metadata }),
      },
    });
  }
}
