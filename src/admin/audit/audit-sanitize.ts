import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Audit metadata must never carry credentials or identity documents. Callers are expected to pass
 * only safe facts (ids, statuses, reasons); this is the safety net behind them: any key that looks
 * secret is replaced, long strings are cut, and depth/size are bounded so a bug cannot write a
 * request body or a document into the permanent log.
 */
const SECRET_KEY = /pass(word|phrase)?|otp|secret|token|authorization|cookie|session|api[_-]?key|credential|private|signature|\bnid\b|national[_-]?id|nid[_-]?(number|no)|ciphertext|iv$|authtag/i;
const MAX_STRING = 300;
const MAX_ITEMS = 25;
const MAX_DEPTH = 4;
export const REDACTED = "[redacted]";

export function sanitizeAuditMetadata(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED; // binary data never belongs in the log
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (item === undefined) continue;
      out[key] = SECRET_KEY.test(key) ? REDACTED : sanitizeAuditMetadata(item, depth + 1);
    }
    return out;
  }
  return null;
}
