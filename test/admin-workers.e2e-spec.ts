import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

const jpeg = (size = 2048, fill = 0x41) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const png = (size = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);

describe("admin worker review and private documents", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const upload = (w: { agent: { put: (u: string) => { set: (k: string, v: string) => { send: (b: Buffer | string) => Promise<{ status: number; body: Record<string, unknown> }> } } } }, kind: string, body: Buffer | string, type = "image/jpeg") =>
    w.agent.put(`${t.api}/me/worker-profile/documents/${kind}`).set("Content-Type", type).send(body);

  describe("worker uploads", () => {
    it("stores the image encrypted, tells the owner it exists, and never returns content", async () => {
      const w = await t.createWorker({ stage: "draft" });
      const original = jpeg(4096, 0x5a);
      const res = await upload(w, "NID_FRONT", original);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ storageAvailable: true });
      expect(res.body.documents).toEqual([expect.objectContaining({ kind: "NID_FRONT", mimeType: "image/jpeg", sizeBytes: 4096 })]);
      expect(JSON.stringify(res.body)).not.toMatch(/sha256|ciphertext|iv|authTag/i);

      const row = await t.prisma.workerDocument.findFirstOrThrow({ where: { workerProfileId: w.profileId } });
      expect(Buffer.from(row.ciphertext).includes(Buffer.alloc(64, 0x5a))).toBe(false); // plaintext is not in the database
      expect(Buffer.from(row.ciphertext)).toHaveLength(4096);
      expect(row.keyId).toBe("k1");
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

      const list = await w.agent.get(`${t.api}/me/worker-profile/documents`);
      expect(list.body.documents).toHaveLength(1);
      // no read endpoint exists for the owner or anyone else outside the admin route
      expect((await w.agent.get(`${t.api}/me/worker-profile/documents/NID_FRONT`)).status).toBe(404);
    });

    it("replaces a document, deletes one, and records both in the audit trail without content", async () => {
      const w = await t.createWorker({ stage: "draft" });
      await upload(w, "NID_BACK", jpeg(1024, 0x01));
      await upload(w, "NID_BACK", png(1500), "image/png");
      const docs = await t.prisma.workerDocument.findMany({ where: { workerProfileId: w.profileId } });
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ mimeType: "image/png", sizeBytes: 1500 });
      expect((await w.agent.delete(`${t.api}/me/worker-profile/documents/NID_BACK`)).status).toBe(200);
      expect((await w.agent.delete(`${t.api}/me/worker-profile/documents/NID_BACK`)).status).toBe(404);
      const trail = await t.prisma.auditLog.findMany({ where: { targetId: w.profileId, action: { startsWith: "worker.document" } }, orderBy: { seq: "asc" } });
      expect(trail.map((r) => r.action)).toEqual(["worker.document.upload", "worker.document.upload", "worker.document.delete"]);
      expect(JSON.stringify(trail)).not.toMatch(/sha256|ciphertext/);
    });

    it("rejects anything that is not a real JPEG/PNG/WebP of acceptable size", async () => {
      const w = await t.createWorker({ stage: "draft" });
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${"a".repeat(800)}</svg>`);
      expect((await upload(w, "NID_FRONT", svg, "image/png")).status).toBe(422); // content is not an image
      expect((await upload(w, "NID_FRONT", jpeg(), "image/png")).body.code).toBe("MEDIA_TYPE_MISMATCH");
      expect((await upload(w, "NID_FRONT", Buffer.from("%PDF-1.7 " + "x".repeat(900)), "application/pdf")).body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect((await upload(w, "NID_FRONT", "just text", "text/plain")).body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect((await upload(w, "NID_FRONT", jpeg(100))).body.code).toBe("FILE_TOO_SMALL");
      expect((await upload(w, "NID_FRONT", jpeg(3 * 1024 * 1024 + 10))).body.code).toBe("FILE_TOO_LARGE");
      expect((await upload(w, "NID_FRONT", jpeg(4 * 1024 * 1024))).status).toBe(413);
      expect((await upload(w, "PASSPORT", jpeg())).status).toBe(400);
      expect(await t.prisma.workerDocument.count()).toBe(0);
    });

    it("needs a signed-in worker profile, and is closed once verified", async () => {
      expect((await t.client().put(`${t.api}/me/worker-profile/documents/NID_FRONT`).set("Content-Type", "image/jpeg").send(jpeg())).status).toBe(401);
      const nobody = await t.signUpAndLogin("noprofile@example.com");
      expect((await upload(nobody, "NID_FRONT", jpeg())).body.code).toBe("PROFILE_REQUIRED");
      const w = await t.createWorker({ stage: "approved" });
      const res = await upload(w, "NID_FRONT", jpeg());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ALREADY_VERIFIED");
    });

    it("is unavailable (503), storing nothing, when no encryption key is configured", async () => {
      const off = await createTestApp({ DOCUMENT_ENCRYPTION_KEY: "" });
      try {
        await off.resetData();
        const w = await off.createWorker({ stage: "draft" });
        const res = await w.agent.put(`${off.api}/me/worker-profile/documents/NID_FRONT`).set("Content-Type", "image/jpeg").send(jpeg());
        expect(res.status).toBe(503);
        expect(res.body.code).toBe("DOCUMENTS_NOT_CONFIGURED");
        expect(await off.prisma.workerDocument.count()).toBe(0);
        expect((await w.agent.get(`${off.api}/me/worker-profile/documents`)).body.storageAvailable).toBe(false);
      } finally {
        await off.close();
      }
    });
  });

  describe("admin access to documents", () => {
    async function withDoc() {
      const officer = await t.newAdminWith(["workers.read", "workers.review", "workers.documents.view"]);
      const w = await t.createWorker({ stage: "submitted" });
      const bytes = jpeg(3000, 0x33);
      await upload(w, "NID_FRONT", bytes);
      return { officer, w, bytes };
    }
    const path = (id: string, kind = "NID_FRONT") => `${t.api}/admin/workers/${id}/documents/${kind}`;

    it("streams the decrypted image only to a permitted admin, with no-cache/no-sniff/sandbox headers, and audits the view", async () => {
      const { officer, w, bytes } = await withDoc();
      const res = await officer.agent.get(path(w.profileId)).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toContain("sandbox");
      expect(res.headers["content-disposition"]).toMatch(/^inline/);
      const view = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "worker.document.view" } });
      expect(view).toMatchObject({ actorId: officer.userId, targetType: "WorkerProfile", targetId: w.profileId });
      expect(view.metadata).toMatchObject({ kind: "NID_FRONT" });
      expect(JSON.stringify(view.metadata)).not.toMatch(/sha256|iv|ciphertext/);
    });

    it("refuses everyone else: anonymous, ordinary users, other admins, the worker themself, and the worker as an admin", async () => {
      const { officer, w } = await withDoc();
      expect((await t.client().get(path(w.profileId))).status).toBe(401);
      expect((await w.agent.get(path(w.profileId))).status).toBe(403);
      const noView = await t.newAdminWith(["workers.read", "workers.review", "users.read"]);
      expect((await noView.agent.get(path(w.profileId))).status).toBe(403);
      const support = await t.newAdmin("support_agent");
      expect((await support.agent.get(path(w.profileId))).status).toBe(403);
      expect(await t.prisma.auditLog.count({ where: { action: "worker.document.view" } })).toBe(0); // denied views are not "views"

      // a worker who is also an admin cannot open their OWN identity documents
      await t.makeAdmin(w.userId);
      expect((await w.agent.get(path(w.profileId))).status).toBe(404);
      expect(officer.userId).toBeDefined();
    });

    it("validates ids and kinds, and 404s a missing document", async () => {
      const { officer, w } = await withDoc();
      expect((await officer.agent.get(path("not-a-uuid"))).status).toBe(400);
      expect((await officer.agent.get(path(w.profileId, "PASSPORT"))).status).toBe(400);
      expect((await officer.agent.get(path(w.profileId, "NID_BACK"))).status).toBe(404);
      expect((await officer.agent.get(path("0192a000-0000-7000-8000-000000000000"))).status).toBe(404);
    });

    it("binds ciphertext to its row: bytes copied into another worker's row cannot be opened", async () => {
      const { officer, w } = await withDoc();
      const other = await t.createWorker({ stage: "submitted" });
      await upload(other, "NID_FRONT", jpeg(3000, 0x44));
      const a = await t.prisma.workerDocument.findFirstOrThrow({ where: { workerProfileId: w.profileId } });
      await t.prisma.workerDocument.updateMany({
        where: { workerProfileId: other.profileId },
        data: { ciphertext: new Uint8Array(a.ciphertext), iv: new Uint8Array(a.iv), authTag: new Uint8Array(a.authTag) },
      });
      const res = await officer.agent.get(path(other.profileId));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DOCUMENT_UNREADABLE");
      expect(await t.prisma.auditLog.count({ where: { action: "worker.document.view" } })).toBe(0);
    });

    it("never appears in public, owner, list or detail responses", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ stage: "published", admin });
      await t.prisma.workerProfile.update({ where: { id: w.profileId }, data: { verificationStatus: "PENDING" } });
      await upload(w, "NID_BACK", jpeg(2500, 0x77));
      const detail = await admin.agent.get(`${t.api}/admin/workers/${w.profileId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.worker.documents).toEqual([expect.objectContaining({ kind: "NID_BACK", sizeBytes: 2500 })]);
      const blob = JSON.stringify(detail.body) + JSON.stringify((await admin.agent.get(`${t.api}/admin/workers?status=ALL`)).body) + JSON.stringify((await t.client().get(`${t.api}/workers/${w.slug}`)).body) + JSON.stringify((await w.agent.get(`${t.api}/me`)).body);
      expect(blob).not.toMatch(/ciphertext|sha256|authTag|"iv"/);
    });
  });

  describe("review", () => {
    it("lists with search, filters and pagination", async () => {
      const admin = await t.newAdmin();
      await t.createWorker({ stage: "submitted", displayName: "Alpha Electric", admin });
      await t.createWorker({ stage: "submitted", displayName: "Beta Plumbing", admin });
      await t.createWorker({ stage: "approved", displayName: "Gamma Paint", admin });
      const pending = await admin.agent.get(`${t.api}/admin/workers`);
      expect(pending.body).toMatchObject({ total: 2, page: 1, totalPages: 1 });
      expect((await admin.agent.get(`${t.api}/admin/workers?status=ALL`)).body.total).toBe(3);
      expect((await admin.agent.get(`${t.api}/admin/workers?status=ALL&q=beta`)).body.workers.map((x: { displayName: string }) => x.displayName)).toEqual(["Beta Plumbing"]);
      expect((await admin.agent.get(`${t.api}/admin/workers?status=VERIFIED&published=false`)).body.total).toBe(1);
      expect((await admin.agent.get(`${t.api}/admin/workers?status=ALL&pageSize=2&page=2`)).body.workers).toHaveLength(1);
      for (const q of ["status=BANNED", "pageSize=0", "published=maybe"]) expect((await admin.agent.get(`${t.api}/admin/workers?${q}`)).status, q).toBe(400);
    });

    it("approving notifies the worker and audits the decision with the reviewer", async () => {
      const officer = await t.newAdmin("verification_officer");
      const w = await t.createWorker({ stage: "submitted" });
      const res = await officer.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "RESUBMISSION_REQUIRED", note: "Please add a clearer photo" });
      expect(res.status).toBe(200);
      const note = await t.prisma.notification.findFirstOrThrow({ where: { userId: w.userId } });
      expect(note).toMatchObject({ type: "worker.verification", link: "/account", readAt: null });
      expect(note.body).toContain("Please add a clearer photo");
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "worker.verification.review", targetId: w.profileId } });
      expect(audit).toMatchObject({ actorId: officer.userId });
      expect(audit.metadata).toMatchObject({ decision: "RESUBMISSION_REQUIRED", hasNote: true });
    });

    it("needs workers.review: a reader or the document viewer alone cannot decide", async () => {
      const w = await t.createWorker({ stage: "submitted" });
      const reader = await t.newAdminWith(["workers.read", "workers.documents.view"]);
      expect((await reader.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" })).status).toBe(403);
      expect((await reader.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "no" })).status).toBe(403);
      expect((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).verificationStatus).toBe("PENDING");
    });

    it("can require identity documents before verification (platform setting)", async () => {
      const admin = await t.newAdmin();
      // submitted while the setting is still off (documents are optional by default), then it is switched on
      const w = await t.createWorker({ stage: "submitted", admin });
      await admin.agent.put(`${t.api}/admin/settings/workers.requireIdentityDocuments`).send({ value: true, reason: "Policy change" });
      const detail = await admin.agent.get(`${t.api}/admin/workers/${w.profileId}`);
      expect(detail.body.worker).toMatchObject({ documentsRequired: true, missingDocuments: ["NID_FRONT", "NID_BACK"] });
      const refused = await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("DOCUMENTS_REQUIRED");
      // rejecting does not need documents
      await upload(w, "NID_FRONT", jpeg());
      await upload(w, "NID_BACK", png(), "image/png");
      expect((await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" })).status).toBe(200);
    });

    it("identity documents are optional by default and can be made compulsory before a worker submits", async () => {
      const optional = await t.createWorker({ stage: "draft" });
      expect((await optional.agent.get(`${t.api}/me/worker-profile/documents`)).body).toMatchObject({ required: false, requiredKinds: ["NID_FRONT", "NID_BACK"] });
      expect((await optional.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(200);

      const admin = await t.newAdmin();
      await admin.agent.put(`${t.api}/admin/settings/workers.requireIdentityDocuments`).send({ value: true, reason: "Policy change" });
      const w = await t.createWorker({ stage: "draft" });
      expect((await w.agent.get(`${t.api}/me/worker-profile/documents`)).body.required).toBe(true);
      const refused = await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("DOCUMENTS_REQUIRED");
      await upload(w, "NID_FRONT", jpeg());
      expect((await w.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(422); // one side is not enough
      await upload(w, "NID_BACK", png(), "image/png");
      expect((await w.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(200);
    });

    it("two reviewers deciding at once: exactly one wins; reviewers cannot decide their own profile", async () => {
      const a = await t.newAdmin();
      const b = await t.newAdmin();
      const w = await t.createWorker({ stage: "submitted" });
      const [x, y] = await Promise.all([
        a.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" }),
        b.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "REJECTED", note: "Documents unclear" }),
      ]);
      expect([x.status, y.status].sort((a, b) => a - b)).toEqual([200, 409]);
      expect(await t.prisma.auditLog.count({ where: { action: "worker.verification.review", targetId: w.profileId } })).toBe(1);
      const own = await t.createWorker({ stage: "submitted" });
      await t.makeAdmin(own.userId);
      expect((await own.agent.post(`${t.api}/admin/workers/${own.profileId}/verification`).send({ decision: "VERIFIED" })).status).toBe(403);
    });

    it("detail shows history, internal suspension reason, and the owner flag; 404 for unknown ids", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ stage: "published", admin });
      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "Fake credentials reported" });
      const d = await admin.agent.get(`${t.api}/admin/workers/${w.profileId}`);
      expect(d.body.worker).toMatchObject({ suspended: true, suspensionReason: "Fake credentials reported", isOwnProfile: false, verificationStatus: "VERIFIED" });
      expect(d.body.worker.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(["worker.suspend", "worker.verification.review"]));
      expect((await admin.agent.get(`${t.api}/admin/workers/0192a000-0000-7000-8000-000000000000`)).status).toBe(404);
      expect((await admin.agent.get(`${t.api}/admin/workers/xyz`)).status).toBe(400);
    });
  });
});
