import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptClient } from "./db.js";

/**
 * One-time (idempotent) import of the knowledge files shipped with the AI service
 * (../rag_agent/knowledge/*.md) into the admin-managed knowledge base, as PUBLISHED v1 documents.
 * Documents whose slug already exists are left alone, so admin edits are never overwritten.
 *
 *   npm run kb:import
 *
 * Only `audience: public` documents are imported. This script writes to the database in DATABASE_URL.
 */
const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "rag_agent", "knowledge");
const prisma = createScriptClient();
try {
  let created = 0;
  let skipped = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`${file}: missing frontmatter`);
    const meta = Object.fromEntries(match[1]!.split("\n").map((l) => l.split(/:(.*)/s).map((p) => p.trim())).filter((p) => p.length >= 2) as [string, string][]);
    if (meta.audience !== "public") { skipped++; continue; }
    const { id, title, url } = meta;
    if (!id || !title || !url) throw new Error(`${file}: id, title and url are required`);
    if (await prisma.knowledgeDocument.findUnique({ where: { slug: id }, select: { id: true } })) { skipped++; continue; }
    const body = match[2]!.trim();
    await prisma.knowledgeDocument.create({
      data: { slug: id, title, url, body, status: "PUBLISHED", publishedAt: new Date(), revisions: { create: { version: 1, title, body } } },
    });
    created++;
  }
  console.log(`Knowledge import: ${created} created, ${skipped} skipped (already present or not public).`);
} finally {
  await prisma.$disconnect();
}
