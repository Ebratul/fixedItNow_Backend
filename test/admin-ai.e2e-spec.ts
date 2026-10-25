import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiClientError, type AiKnowledgeSummary } from "../src/ai/ai-client.js";
import { knowledgeDigest } from "../src/admin/ai/knowledge.digest.js";
import { createTestApp, type TestApp } from "./helpers.js";

const AI = { AI_SERVICE_URL: "http://ai.test:8000", AI_SERVICE_TOKEN: "s".repeat(40), APP_API_SERVICE_TOKEN: "t".repeat(40) };
const BODY = "# Staying safe\nKeep payments and conversations inside FixedItNow. Never share your one time code with anyone, including staff.";

/** Stands in for the Python service's knowledge endpoints. Never reaches a network. */
class FakeAi {
  reachable = true;
  running: AiKnowledgeSummary = { source: "api", configuredSource: "api", documents: 0, chunks: 0, digest: knowledgeDigest([]) };
  failReload = false;
  reloads = 0;
  nextDigest: (() => Promise<string>) | null = null;
  async chat() { return {}; }
  async health() { return this.reachable ? { status: "ok", llm: "not_configured" } : null; }
  async knowledgeStatus() { return this.reachable ? this.running : null; }
  async reloadKnowledge() {
    this.reloads++;
    if (this.failReload) throw new AiClientError("unreachable");
    if (this.nextDigest) this.running = { ...this.running, digest: await this.nextDigest() };
    return this.running;
  }
}

describe("admin AI knowledge base", () => {
  const fake = new FakeAi();
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(AI, { aiClient: fake as never }); });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetData();
    fake.reachable = true; fake.failReload = false; fake.reloads = 0; fake.nextDigest = null;
    fake.running = { source: "api", configuredSource: "api", documents: 0, chunks: 0, digest: knowledgeDigest([]) };
  });

  const doc = { slug: "safety-tips", title: "Staying safe", url: "/help", body: BODY };
  const create = (a: { agent: { post: (u: string) => { send: (b: object) => Promise<{ status: number; body: Record<string, any> }> } } }, b: object = {}) =>
    a.agent.post(`${t.api}/admin/ai/knowledge`).send({ ...doc, ...b });

  describe("documents", () => {
    it("creates a draft with a first revision, and audits it without copying the text", async () => {
      const admin = await t.newAdmin();
      const res = await create(admin);
      expect(res.status).toBe(201);
      expect(res.body.document).toMatchObject({ slug: "safety-tips", status: "DRAFT", version: 1, allowedNext: ["PUBLISHED", "ARCHIVED"] });
      expect(await t.prisma.knowledgeRevision.count()).toBe(1);
      const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "ai.knowledge.create" } });
      expect(entry).toMatchObject({ actorId: admin.userId });
      expect(JSON.stringify(entry.metadata)).not.toContain("one time code");
      expect((await create(admin)).body.code).toBe("SLUG_TAKEN");
    });

    it("validates every field", async () => {
      const admin = await t.newAdmin();
      const bad = [
        { slug: "Bad Slug" }, { slug: "" }, { slug: "-start" }, { slug: "a".repeat(41) }, { title: "ab" }, { url: "https://evil.example" },
        { url: "help" }, { url: "/Has Space" }, { body: "too short" }, { body: "x".repeat(20_001) }, { body: "nul\u0000byte in the document text" }, { status: "PUBLISHED" },
      ];
      for (const b of bad) expect((await create(admin, b)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(await t.prisma.knowledgeDocument.count()).toBe(0);
    });

    it("edits bump the version and keep every previous text; revert restores one", async () => {
      const admin = await t.newAdmin();
      const id = (await create(admin)).body.document.id as string;
      const patch = (b: object) => admin.agent.patch(`${t.api}/admin/ai/knowledge/${id}`).send(b);
      expect((await patch({})).status).toBe(400);
      expect((await patch({ title: doc.title })).body.code).toBe("NO_CHANGE");
      const v2 = await patch({ body: `${BODY}\nStaff will never ask for it.` });
      expect(v2.body.document).toMatchObject({ version: 2 });
      expect((await patch({ title: "Safety tips" })).body.document.version).toBe(3);
      const detail = await admin.agent.get(`${t.api}/admin/ai/knowledge/${id}`);
      expect(detail.body.document.revisions.map((r: { version: number }) => r.version)).toEqual([3, 2, 1]);
      expect((await admin.agent.get(`${t.api}/admin/ai/knowledge/${id}/revisions/1`)).body.revision.body).toBe(BODY);
      expect((await admin.agent.get(`${t.api}/admin/ai/knowledge/${id}/revisions/99`)).status).toBe(404);
      const reverted = await admin.agent.post(`${t.api}/admin/ai/knowledge/${id}/revert`).send({ version: 1 });
      expect(reverted.body.document).toMatchObject({ version: 4, title: "Staying safe", body: BODY });
      expect(await t.prisma.auditLog.count({ where: { action: "ai.knowledge.revert" } })).toBe(1);
    });

    it("moves through draft, published and archived only along allowed paths, and publishing needs confirm", async () => {
      const admin = await t.newAdmin();
      const id = (await create(admin)).body.document.id as string;
      const status = (b: object) => admin.agent.post(`${t.api}/admin/ai/knowledge/${id}/status`).send(b);
      expect((await status({ status: "PUBLISHED" })).status).toBe(400);
      expect((await status({ status: "PUBLISHED", confirm: false })).status).toBe(400);
      expect((await status({ status: "LIVE", confirm: true })).status).toBe(400);
      expect((await status({ status: "PUBLISHED", confirm: true })).body.document).toMatchObject({ status: "PUBLISHED", allowedNext: ["DRAFT", "ARCHIVED"] });
      expect((await status({ status: "PUBLISHED", confirm: true })).body.code).toBe("INVALID_TRANSITION");
      expect((await status({ status: "ARCHIVED" })).status).toBe(200);
      expect((await admin.agent.patch(`${t.api}/admin/ai/knowledge/${id}`).send({ title: "Edited while archived" })).body.code).toBe("ARCHIVED");
      expect((await status({ status: "PUBLISHED", confirm: true })).body.code).toBe("INVALID_TRANSITION");
      expect((await status({ status: "DRAFT" })).body.document.status).toBe("DRAFT");
      const actions = (await t.prisma.auditLog.findMany({ where: { targetId: id, action: { startsWith: "ai.knowledge." } }, orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(actions).toEqual(["ai.knowledge.create", "ai.knowledge.publish", "ai.knowledge.archive", "ai.knowledge.restore"]);
    });

    it("lists and searches documents, with no text in the list", async () => {
      const admin = await t.newAdmin();
      await create(admin);
      await create(admin, { slug: "tipping", title: "Tipping", body: "# Tipping\nTipping is optional and agreed between you and the professional." });
      const list = await admin.agent.get(`${t.api}/admin/ai/knowledge`);
      expect(list.body.documents.map((d: { slug: string }) => d.slug)).toEqual(["safety-tips", "tipping"]);
      expect(list.body.documents[0]).toMatchObject({ characters: BODY.length });
      expect(JSON.stringify(list.body)).not.toContain("one time code");
      expect((await admin.agent.get(`${t.api}/admin/ai/knowledge?q=optional`)).body.documents).toHaveLength(1);
      expect((await admin.agent.get(`${t.api}/admin/ai/knowledge?status=PUBLISHED`)).body.documents).toHaveLength(0);
      expect((await admin.agent.get(`${t.api}/admin/ai/knowledge?status=LIVE`)).status).toBe(400);
    });

    it("separates reading from managing", async () => {
      const reader = await t.newAdminWith(["ai.read"]);
      const manager = await t.newAdminWith(["ai.read", "ai.manage"]);
      const none = await t.newAdminWith(["users.read"]);
      const id = (await create(manager)).body.document.id as string;
      expect((await reader.agent.get(`${t.api}/admin/ai/knowledge`)).status).toBe(200);
      expect((await reader.agent.get(`${t.api}/admin/ai/status`)).status).toBe(200);
      expect((await create(reader, { slug: "other" })).status).toBe(403);
      expect((await reader.agent.patch(`${t.api}/admin/ai/knowledge/${id}`).send({ title: "Hacked title" })).status).toBe(403);
      expect((await reader.agent.post(`${t.api}/admin/ai/knowledge/${id}/status`).send({ status: "ARCHIVED" })).status).toBe(403);
      expect((await reader.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true })).status).toBe(403);
      expect((await none.agent.get(`${t.api}/admin/ai/knowledge`)).status).toBe(403);
      expect(fake.reloads).toBe(0);
    });
  });

  describe("serving the assistant", () => {
    const serviceGet = (token?: string) => t.client().get(`${t.api}/internal/ai/knowledge`).set(token ? { Authorization: `Bearer ${token}` } : {});

    it("serves only PUBLISHED documents, and only to the AI service token", async () => {
      const admin = await t.newAdmin();
      const publish = async (slug: string) => {
        const id = (await create(admin, { slug, title: `Doc ${slug}`, body: `# ${slug}\n${"Helpful text about the platform. ".repeat(3)}` })).body.document.id as string;
        return id;
      };
      const a = await publish("alpha");
      await publish("beta-draft");
      const c = await publish("gamma-archived");
      await admin.agent.post(`${t.api}/admin/ai/knowledge/${a}/status`).send({ status: "PUBLISHED", confirm: true });
      await admin.agent.post(`${t.api}/admin/ai/knowledge/${c}/status`).send({ status: "ARCHIVED" });

      expect((await serviceGet()).status).toBe(401);
      expect((await serviceGet("wrong".repeat(10))).status).toBe(401);
      expect((await t.client().get(`${t.api}/internal/ai/knowledge`).set("Authorization", `Bearer ${AI.AI_SERVICE_TOKEN}`)).status).toBe(401); // the OTHER direction's token
      expect((await admin.agent.get(`${t.api}/internal/ai/knowledge`)).status).toBe(401); // an admin session is not the service
      const ok = await serviceGet(AI.APP_API_SERVICE_TOKEN);
      expect(ok.status).toBe(200);
      expect(ok.body.documents).toEqual([expect.objectContaining({ id: "alpha", title: "Doc alpha", url: "/help", version: 1 })]);
      expect(Object.keys(ok.body.documents[0]).sort()).toEqual(["body", "id", "title", "url", "version"]);
    });
  });

  describe("status and sync", () => {
    it("reports whether the running assistant matches the published content, honestly", async () => {
      const admin = await t.newAdmin();
      const id = (await create(admin)).body.document.id as string;
      await admin.agent.post(`${t.api}/admin/ai/knowledge/${id}/status`).send({ status: "PUBLISHED", confirm: true });
      const before = (await admin.agent.get(`${t.api}/admin/ai/status`)).body;
      expect(before.service).toMatchObject({ configured: true, reachable: true, assistantEnabled: true });
      expect(before.knowledge).toMatchObject({ published: 1, draft: 0, inSync: false, lastSync: null });
      expect(before.knowledge.expectedDigest).toBe(knowledgeDigest([{ id: "safety-tips", title: doc.title, url: doc.url, body: BODY }]));

      fake.nextDigest = async () => before.knowledge.expectedDigest;
      fake.running = { ...fake.running, documents: 1, chunks: 1 };
      const sync = await admin.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true });
      expect(sync.status).toBe(200);
      expect(sync.body).toMatchObject({ synced: true, inSync: true, source: "api", documents: 1 });
      const after = (await admin.agent.get(`${t.api}/admin/ai/status`)).body;
      expect(after.knowledge.inSync).toBe(true);
      expect(after.knowledge.lastSync).toMatchObject({ ok: true });
      expect(await t.prisma.auditLog.count({ where: { action: "ai.knowledge.sync", actorId: admin.userId } })).toBe(1);
    });

    it("never claims 'in sync' when the AI service reads bundled files", async () => {
      const admin = await t.newAdmin();
      fake.running = { source: "files", configuredSource: "files", documents: 7, chunks: 21, digest: "f".repeat(64) };
      const sync = await admin.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true });
      expect(sync.body).toMatchObject({ synced: true, inSync: false, source: "files" });
      expect(sync.body.hint).toMatch(/AI_KNOWLEDGE_SOURCE/);
      expect((await admin.agent.get(`${t.api}/admin/ai/status`)).body.knowledge.inSync).toBe(false);
    });

    it("needs confirmation, reports a failure without pretending success, and logs both outcomes", async () => {
      const admin = await t.newAdmin();
      expect((await admin.agent.post(`${t.api}/admin/ai/sync`).send({})).status).toBe(400);
      expect(fake.reloads).toBe(0);
      fake.failReload = true;
      const failed = await admin.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true });
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe("AI_SYNC_FAILED");
      const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "ai.knowledge.sync_failed" } });
      expect(entry.metadata).toMatchObject({ reason: "unreachable" });
      expect((await admin.agent.get(`${t.api}/admin/ai/status`)).body.knowledge.lastSync).toMatchObject({ ok: false });
    });

    it("shows an unreachable service as such", async () => {
      const admin = await t.newAdmin();
      fake.reachable = false;
      const status = (await admin.agent.get(`${t.api}/admin/ai/status`)).body;
      expect(status.service).toMatchObject({ configured: true, reachable: false });
      expect(status.knowledge.running).toBeNull();
      expect(status.knowledge.inSync).toBe(false);
    });
  });

  it("without an AI service configured, sync is refused and status says so", async () => {
    const bare = await createTestApp();
    try {
      await bare.resetData();
      const admin = await bare.newAdmin();
      expect((await admin.agent.post(`${bare.api}/admin/ai/sync`).send({ confirm: true })).body.code).toBe("AI_NOT_CONFIGURED");
      expect((await admin.agent.get(`${bare.api}/admin/ai/status`)).body.service).toMatchObject({ configured: false, reachable: false });
    } finally {
      await bare.close();
    }
  });
});
