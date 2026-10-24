import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, uniqueEmail, type TestApp } from "./helpers.js";

describe("worker profile lifecycle and public listing", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const publish = (agent: any) => agent.post(`${t.api}/me/worker-profile/publish`).send({});
  const unpublish = (agent: any) => agent.post(`${t.api}/me/worker-profile/unpublish`).send({});
  const publicProfile = (slug: string) => t.client().get(`${t.api}/workers/${slug}`);

  describe("publishing", () => {
    it("a completed profile is NOT published or listed automatically", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ stage: "approved", admin });
      const me = (await w.agent.get(`${t.api}/me`)).body.worker.profile;
      expect(me).toMatchObject({ verificationStatus: "VERIFIED", publishedAt: null, slug: null });
      expect((await t.client().get(`${t.api}/workers`)).body.total).toBe(0);
    });

    it("cannot be published before approval", async () => {
      for (const stage of ["draft", "submitted"] as const) {
        const w = await t.createWorker({ stage });
        expect((await publish(w.agent)).status).toBe(409);
      }
      expect((await publish((await t.signUpAndLogin(uniqueEmail())).agent)).status).toBe(400); // no profile at all
      expect(await t.prisma.workerProfile.count({ where: { publishedAt: { not: null } } })).toBe(0);
    });

    it("publishes an approved profile under a stable, unguessable slug", async () => {
      const w = await t.createWorker({ displayName: "Rahim Uddin" });
      expect(w.slug).toMatch(/^rahim-uddin-[0-9a-f]{8}$/);
      expect((await publicProfile(w.slug!)).status).toBe(200);

      // Idempotent: republishing keeps the original slug and publication time.
      const before = await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } });
      const again = await publish(w.agent);
      expect(again.body.profile.slug).toBe(w.slug);
      expect((await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } })).publishedAt).toEqual(before.publishedAt);
    });

    it("concurrent publish requests allocate exactly one slug", async () => {
      const w = await t.createWorker({ stage: "approved" });
      const results = await Promise.all(Array.from({ length: 6 }, () => publish(w.agent)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.profile.slug)).size).toBe(1);
    });

    it("a non-ASCII name still gets a valid slug", async () => {
      const w = await t.createWorker({ displayName: "রহিম উদ্দিন" });
      expect(w.slug).toMatch(/^worker-[0-9a-f]{8}$/);
    });

    it("unpublish removes the profile from public view and republish restores it", async () => {
      const w = await t.createWorker();
      expect((await unpublish(w.agent)).status).toBe(200);
      expect((await unpublish(w.agent)).status).toBe(200); // idempotent
      expect((await publicProfile(w.slug!)).status).toBe(404);
      expect((await t.client().get(`${t.api}/workers`)).body.total).toBe(0);
      await publish(w.agent);
      expect((await publicProfile(w.slug!)).status).toBe(200);
    });

    it("requires authentication and a same-origin request", async () => {
      expect((await publish(t.client())).status).toBe(401);
      const w = await t.createWorker({ stage: "approved" });
      const evil = await w.agent.post(`${t.api}/me/worker-profile/publish`).set("Origin", "https://evil.example").send({});
      expect(evil.status).toBe(403);
    });
  });

  describe("moderation (admin-only)", () => {
    it("suspension hides the profile everywhere, blocks republishing, and is audit-logged", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ admin });
      const res = await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "Reported for spam" });
      expect(res.status).toBe(200);
      expect(res.body.worker.suspended).toBe(true);

      expect((await publicProfile(w.slug!)).status).toBe(404);
      expect((await t.client().get(`${t.api}/workers`)).body.total).toBe(0);
      expect((await publish(w.agent)).status).toBe(403);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "worker.suspend" } });
      expect(audit.actorId).toBe(admin.userId);

      // The internal reason is never shown to the owner or the public.
      const ownerView = JSON.stringify((await w.agent.get(`${t.api}/me`)).body);
      expect(ownerView).not.toContain("Reported for spam");
      expect(ownerView).not.toContain("suspensionReason");

      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: false });
      expect((await publicProfile(w.slug!)).status).toBe(200);
    });

    it("only admins can suspend; a reason is required; an admin cannot suspend themselves", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ admin });
      const other = await t.signUpAndLogin(uniqueEmail("o"));
      const body = { suspended: true, reason: "x" };
      expect((await w.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send(body)).status).toBe(403); // owner can't suspend/unsuspend self
      expect((await other.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send(body)).status).toBe(403);
      expect((await t.client().post(`${t.api}/admin/workers/${w.profileId}/suspension`).send(body)).status).toBe(401);
      expect((await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true })).status).toBe(400);
      expect((await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/suspension`).send({ suspended: true, reason: "x", extra: 1 })).status).toBe(400);
      expect((await admin.agent.post(`${t.api}/admin/workers/not-a-uuid/suspension`).send(body)).status).toBe(400);
      expect(await t.prisma.workerProfile.count({ where: { suspendedAt: { not: null } } })).toBe(0);

      const own = await t.createWorker({ stage: "submitted" });
      await t.makeAdmin(own.userId);
      expect((await own.agent.post(`${t.api}/admin/workers/${own.profileId}/suspension`).send(body)).status).toBe(403);
    });
  });

  describe("owner profile editing", () => {
    it("edits appear on the public profile and recompute the starting price", async () => {
      const w = await t.createWorker({ displayName: "Old Name" });
      const res = await w.agent.put(`${t.api}/me/worker-profile`).send({
        displayName: "New Name",
        headline: "Updated headline",
        services: [{ categorySlug: "plumbing", pricingModel: "HOURLY", basePriceBdt: 250 }, { categorySlug: "painting", pricingModel: "QUOTE" }],
      });
      expect(res.status).toBe(200);
      const pub = (await publicProfile(w.slug!)).body.worker;
      expect(pub).toMatchObject({ displayName: "New Name", headline: "Updated headline", startingPriceBdt: 250 });
      expect(pub.services.map((s: any) => s.category.slug).sort()).toEqual(["painting", "plumbing"]);
      // Slug is stable across renames.
      expect(pub.slug).toBe(w.slug);
    });

    it("quote-only services leave the starting price empty", async () => {
      const w = await t.createWorker();
      await w.agent.put(`${t.api}/me/worker-profile`).send({ services: [{ categorySlug: "plumbing", pricingModel: "QUOTE" }] });
      expect((await publicProfile(w.slug!)).body.worker.startingPriceBdt).toBeNull();
    });

    it("cannot modify trusted, listing, or moderation fields", async () => {
      const w = await t.createWorker();
      for (const patch of [
        { verificationStatus: "VERIFIED" }, { onboardingStatus: "DRAFT" }, { slug: "my-own-slug" },
        { publishedAt: "2020-01-01T00:00:00Z" }, { isPublished: true }, { suspendedAt: null },
        { suspensionReason: "none" }, { startingPriceBdt: 1 }, { userId: "x" }, { id: "x" }, { role: "ADMIN" },
      ]) {
        const res = await w.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Name", ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
      }
      const row = await t.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.profileId } });
      expect(row.slug).toBe(w.slug);
      expect(row.verificationStatus).toBe("VERIFIED");
    });

    it("a worker cannot edit or publish another worker's profile", async () => {
      const a = await t.createWorker({ displayName: "Worker A" });
      const b = await t.createWorker({ displayName: "Worker B" });
      await a.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "A renamed", id: b.profileId }); // rejected
      await a.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "A renamed" });
      expect((await publicProfile(b.slug!)).body.worker.displayName).toBe("Worker B");
      await unpublish(a.agent);
      expect((await publicProfile(b.slug!)).status).toBe(200); // A's unpublish only affects A
    });

    it("rejects invalid values and inactive/unknown categories", async () => {
      const w = await t.createWorker();
      await t.prisma.serviceCategory.update({ where: { slug: "carpentry" }, data: { isActive: false } });
      try {
        expect((await w.agent.put(`${t.api}/me/worker-profile`).send({ services: [{ categorySlug: "carpentry", pricingModel: "QUOTE" }] })).status).toBe(400);
      } finally {
        await t.prisma.serviceCategory.update({ where: { slug: "carpentry" }, data: { isActive: true } });
      }
      for (const bad of [{ experienceYears: 61 }, { bio: "x".repeat(1001) }, { headline: "x".repeat(81) }, { languages: ["Klingon"] }, { serviceAreas: ["Mars"] }]) {
        expect((await w.agent.put(`${t.api}/me/worker-profile`).send(bad)).status).toBe(400);
      }
    });
  });

  describe("owner view", () => {
    it("shows listing state but never the internal moderation note", async () => {
      const admin = await t.newAdmin();
      const w = await t.createWorker({ admin });
      const profile = (await w.agent.get(`${t.api}/me`)).body.worker.profile;
      expect(profile).toMatchObject({ slug: w.slug, verificationStatus: "VERIFIED" });
      expect(profile.publishedAt).toBeTruthy();
      expect(profile).not.toHaveProperty("suspensionReason");
    });
  });
});
