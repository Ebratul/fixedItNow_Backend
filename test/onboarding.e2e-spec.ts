import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, uniqueEmail, validWorkerProfile, type TestApp } from "./helpers.js";

describe("onboarding", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  describe("customer", () => {
    it("creates and updates a customer profile (idempotent)", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      expect((await u.agent.get(`${t.api}/me`)).body.customer.onboarded).toBe(false);

      const first = await u.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "  Karim  ", preferredDivision: "Sylhet" });
      expect(first.status).toBe(200);
      expect(first.body.profile).toEqual({ displayName: "Karim", preferredDivision: "Sylhet" });
      await u.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Karim", preferredDivision: null });

      const me = (await u.agent.get(`${t.api}/me`)).body;
      expect(me.customer.onboarded).toBe(true);
      expect(me.customer.profile.preferredDivision).toBeNull();
      expect(await t.prisma.customerProfile.count({ where: { userId: u.userId } })).toBe(1);
    });

    it.each([
      ["a one-character name", { displayName: "K" }],
      ["a blank name", { displayName: "   " }],
      ["an over-long name", { displayName: "x".repeat(61) }],
      ["an unknown division", { displayName: "Karim", preferredDivision: "Atlantis" }],
      ["a missing name", {}],
      ["a non-string name", { displayName: 123 }],
    ])("rejects %s", async (_l, body) => {
      const u = await t.signUpAndLogin(uniqueEmail());
      expect((await u.agent.put(`${t.api}/me/customer-profile`).send(body)).status).toBe(400);
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });
  });

  describe("worker", () => {
    it("saves progress step by step and can resume", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      const s1 = await u.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Rahim", onboardingStep: 2 });
      expect(s1.status).toBe(200);
      expect(s1.body.profile.onboardingStatus).toBe("DRAFT");
      expect(s1.body.profile.verificationStatus).toBe("NOT_SUBMITTED");

      await u.agent.put(`${t.api}/me/worker-profile`).send({ services: validWorkerProfile.services, onboardingStep: 3 });
      await u.agent.put(`${t.api}/me/worker-profile`).send({ bio: validWorkerProfile.bio, experienceYears: 4 });

      const me = (await u.agent.get(`${t.api}/me`)).body.worker;
      expect(me.started).toBe(true);
      expect(me.approved).toBe(false);
      expect(me.profile.displayName).toBe("Rahim"); // earlier steps preserved
      expect(me.profile.onboardingStep).toBe(3);
      expect(me.profile.services).toHaveLength(2);
      expect(me.profile.services[0].category.slug).toBeDefined();
    });

    it("replaces services wholesale and keeps one row per category", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      await u.agent.put(`${t.api}/me/worker-profile`).send({ services: validWorkerProfile.services });
      const res = await u.agent.put(`${t.api}/me/worker-profile`).send({
        services: [{ categorySlug: "plumbing", pricingModel: "HOURLY", basePriceBdt: 400, pricingNotes: "Parts extra" }],
      });
      expect(res.body.profile.services).toHaveLength(1);
      expect(res.body.profile.services[0]).toMatchObject({ pricingModel: "HOURLY", basePriceBdt: 400 });
    });

    it.each([
      ["an unknown category", { services: [{ categorySlug: "teleportation", pricingModel: "QUOTE" }] }],
      ["a FIXED service without a price", { services: [{ categorySlug: "plumbing", pricingModel: "FIXED" }] }],
      ["a QUOTE service with a price", { services: [{ categorySlug: "plumbing", pricingModel: "QUOTE", basePriceBdt: 100 }] }],
      ["a negative price", { services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: -5 }] }],
      ["a fractional price", { services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 99.5 }] }],
      ["a duplicate category", { services: [{ categorySlug: "plumbing", pricingModel: "QUOTE" }, { categorySlug: "plumbing", pricingModel: "QUOTE" }] }],
      ["too many services", { services: ["electrical", "plumbing", "ac-repair", "painting", "carpentry", "pest-control"].map((categorySlug) => ({ categorySlug, pricingModel: "QUOTE" })) }],
      ["an unknown division", { serviceAreas: ["Narnia"] }],
      ["an unknown language", { languages: ["Klingon"] }],
      ["negative experience", { experienceYears: -1 }],
      ["a step out of range", { onboardingStep: 9 }],
      ["an over-long bio", { bio: "x".repeat(1001) }],
    ])("rejects %s", async (_l, body) => {
      const u = await t.signUpAndLogin(uniqueEmail());
      const res = await u.agent.put(`${t.api}/me/worker-profile`).send(body);
      expect(res.status).toBe(400);
      expect(await t.prisma.workerService.count()).toBe(0);
    });

    it("refuses to submit an incomplete profile and lists what is missing", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      expect((await u.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(400); // nothing started
      await u.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Rahim" });
      const res = await u.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect(res.status).toBe(400);
      const paths = res.body.errors.map((e: any) => e.path);
      expect(paths).toEqual(expect.arrayContaining(["bio", "experienceYears", "languages", "serviceAreas", "services"]));
      const row = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: u.userId } });
      expect(row.onboardingStatus).toBe("DRAFT");
      expect(row.verificationStatus).toBe("NOT_SUBMITTED");
    });

    it("submits a complete profile for review without approving it", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      await u.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      const res = await u.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ onboardingStatus: "SUBMITTED", verificationStatus: "PENDING" });
      expect((await u.agent.get(`${t.api}/me`)).body.worker.approved).toBe(false);
      // Cannot submit twice.
      expect((await u.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(409);
    });

    it("lets a worker revise and resubmit after a reviewer asks for changes", async () => {
      const w = await t.signUpAndLogin(uniqueEmail("w"));
      const admin = await t.signUpAndLogin(uniqueEmail("admin"));
      await t.makeAdmin(admin.userId);
      await w.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      const profile = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: w.userId } });
      await admin.agent.post(`${t.api}/admin/workers/${profile.id}/verification`).send({ decision: "RESUBMISSION_REQUIRED", note: "Please add more detail." });

      const me = (await w.agent.get(`${t.api}/me`)).body.worker.profile;
      expect(me.verificationStatus).toBe("RESUBMISSION_REQUIRED");
      expect(me.reviewNote).toBe("Please add more detail."); // minimal reason is shared with the owner
      expect(JSON.stringify(me)).not.toContain(admin.userId); // reviewer identity is not

      await w.agent.put(`${t.api}/me/worker-profile`).send({ bio: validWorkerProfile.bio + " Now with more detail." });
      const again = await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      expect(again.status).toBe(200);
      expect(again.body.profile.verificationStatus).toBe("PENDING");
    });

    it("rejected workers cannot simply resubmit", async () => {
      const w = await t.signUpAndLogin(uniqueEmail("w"));
      const admin = await t.signUpAndLogin(uniqueEmail("admin"));
      await t.makeAdmin(admin.userId);
      await w.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      const profile = await t.prisma.workerProfile.findFirstOrThrow({ where: { userId: w.userId } });
      await admin.agent.post(`${t.api}/admin/workers/${profile.id}/verification`).send({ decision: "REJECTED", note: "Does not meet requirements." });
      expect((await w.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(409);
    });
  });

  describe("one account, both capabilities", () => {
    it("lets the same user be a customer and a worker", async () => {
      const u = await t.signUpAndLogin(uniqueEmail());
      await u.agent.put(`${t.api}/me/customer-profile`).send({ displayName: "Dual User" });
      await u.agent.put(`${t.api}/me/worker-profile`).send(validWorkerProfile);
      const me = (await u.agent.get(`${t.api}/me`)).body;
      expect(me.customer.onboarded).toBe(true);
      expect(me.worker.started).toBe(true);
      expect(await t.prisma.user.count()).toBe(1);
    });
  });

  describe("public reference data", () => {
    it("serves active categories from the database", async () => {
      const res = await t.client().get(`${t.api}/categories`);
      expect(res.body.categories.length).toBeGreaterThanOrEqual(10);
      expect(res.body.categories[0]).toEqual({ slug: expect.any(String), name: expect.any(String), description: expect.any(String) });
    });
  });
});
