import { createHash } from "node:crypto";

/**
 * Content hash of a document set; byte-for-byte the algorithm of `documents_digest` in the AI
 * service (rag_agent/app/knowledge.py): sha256 over `id NUL title NUL url NUL body NUL`, documents
 * sorted by id, UTF-8. Equal digests mean the running index was built from exactly this content.
 */
export function knowledgeDigest(docs: { id: string; title: string; url: string; body: string }[]): string {
  const hash = createHash("sha256");
  for (const doc of [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const field of [doc.id, doc.title, doc.url, doc.body]) hash.update(Buffer.concat([Buffer.from(field, "utf8"), Buffer.from([0])]));
  }
  return hash.digest("hex");
}
