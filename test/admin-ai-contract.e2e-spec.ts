import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

/**
 * CROSS-PROCESS CONTRACT for admin-managed knowledge. The real Python AI service runs as a
 * subprocess with AI_KNOWLEDGE_SOURCE=api, against this real NestJS app: an administrator publishes
 * documents, syncs, and the running assistant answers from them. It also proves both languages compute the
 * SAME content digest (the basis of the "in sync" indicator). No language model is involved
 * (the service runs in its simple mode).
 *
 * Skipped automatically when the Python virtualenv (rag_agent/.venv) is missing.
 */
const root = path.resolve(import.meta.dirname, "../../rag_agent");
const python = path.join(root, ".venv/bin/python");
const TOKENS = { AI_SERVICE_TOKEN: "s".repeat(40), APP_API_SERVICE_TOKEN: "t".repeat(40) };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!existsSync(python))("admin knowledge: Nest <-> Python (real processes)", () => {
  let t: TestApp;
  let ai: ChildProcess;
  let aiPort = 0;
  let aiLog = "";

  beforeAll(async () => {
    aiPort = await freePort();
    t = await createTestApp({ AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`, AI_RATE_LIMIT_PER_MINUTE: "100", ...TOKENS });
    await t.app.listen(0, "127.0.0.1");
    const apiPort = (t.app.getHttpServer().address() as { port: number }).port;
    ai = spawn(python, ["-m", "uvicorn", "app.main:app_from_env", "--factory", "--host", "127.0.0.1", "--port", String(aiPort)], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        APP_ENV: "test",
        AI_KNOWLEDGE_SOURCE: "api",
        AI_SERVICE_TOKEN: TOKENS.AI_SERVICE_TOKEN,
        APP_API_SERVICE_TOKEN: TOKENS.APP_API_SERVICE_TOKEN,
        APP_API_BASE_URL: `http://127.0.0.1:${apiPort}/api/v1`,
        AI_RATE_LIMIT_PER_MINUTE: "100",
      },
    });
    ai.stdout?.on("data", (d) => (aiLog += d));
    ai.stderr?.on("data", (d) => (aiLog += d));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${aiPort}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`AI service did not start:\n${aiLog}`);
  }, 60_000);

  afterAll(async () => {
    ai?.kill("SIGTERM");
    await t?.close();
  });
  beforeEach(() => t.resetData());

  const TIP_BODY = "# Tipping a professional\nTipping is optional. FixedItNow never adds a tip to the price; it is agreed between you and the professional, and unicode like ৳ and বাংলা must hash identically.";

  async function publish(admin: Awaited<ReturnType<TestApp["newAdmin"]>>, slug: string, title: string, body: string) {
    const id = (await admin.agent.post(`${t.api}/admin/ai/knowledge`).send({ slug, title, url: "/help", body })).body.document.id as string;
    expect((await admin.agent.post(`${t.api}/admin/ai/knowledge/${id}/status`).send({ status: "PUBLISHED", confirm: true })).status).toBe(200);
    return id;
  }

  it("publish, sync, and the running assistant answers from the new document (and the digests agree across languages)", async () => {
    const admin = await t.newAdmin();
    const user = await t.signUpAndLogin("asker@example.com");
    const ask = () => user.agent.post(`${t.api}/ai/chat`).send({ message: "how do I tip a professional" });

    // before: nothing published, the assistant has no answer for tipping
    expect((await ask()).body.answer).toBeNull();

    await publish(admin, "tipping", "Tipping", TIP_BODY);
    const stale = (await admin.agent.get(`${t.api}/admin/ai/status`)).body;
    expect(stale.knowledge.inSync).toBe(false); // published but not yet synced

    const sync = await admin.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ synced: true, inSync: true, source: "api", documents: 1 });

    const status = (await admin.agent.get(`${t.api}/admin/ai/status`)).body;
    expect(status.knowledge.inSync).toBe(true);
    expect(status.knowledge.running.digest).toBe(status.knowledge.expectedDigest); // same sha256 from Python and TypeScript

    const answer = (await ask()).body;
    expect(answer.kind).toBe("answer");
    expect(answer.answer).toMatchObject({ grounded: true });
    expect(answer.answer.sources[0]).toMatchObject({ id: "tipping#tipping-a-professional", url: "/help" });

    // unpublishing takes effect after the next sync, not before
    const id = (await t.prisma.knowledgeDocument.findUniqueOrThrow({ where: { slug: "tipping" } })).id;
    await admin.agent.post(`${t.api}/admin/ai/knowledge/${id}/status`).send({ status: "DRAFT" });
    expect((await admin.agent.get(`${t.api}/admin/ai/status`)).body.knowledge.inSync).toBe(false);
    await admin.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true });
    expect((await ask()).body.answer).toBeNull();
  });

  it("the Python service rejects reload without its token, and only the Nest app (holding it) can trigger a sync", async () => {
    expect((await fetch(`http://127.0.0.1:${aiPort}/v1/knowledge/reload`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${aiPort}/v1/knowledge`)).status).toBe(401);
    const user = await t.signUpAndLogin("nosync@example.com");
    expect((await user.agent.post(`${t.api}/admin/ai/sync`).send({ confirm: true })).status).toBe(403);
  });
});
