import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("service categories", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.prisma.serviceCategory.updateMany({ data: { isActive: true } });
    await t.close();
  });
  beforeEach(async () => {
    await t.resetData();
    await t.prisma.serviceCategory.updateMany({ data: { isActive: true } });
  });

  it("lists active categories with a COMPUTED worker count", async () => {
    const admin = await t.newAdmin();
    let res = await t.client().get(`${t.api}/categories`);
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThanOrEqual(10);
    expect(res.body.categories.every((c: any) => c.workerCount === 0)).toBe(true);

    await t.createWorker({ admin }); // electrical + ac-repair
    await t.createWorker({ admin, services: [{ categorySlug: "electrical", pricingModel: "QUOTE" }] });
    res = await t.client().get(`${t.api}/categories`);
    const count = (slug: string) => res.body.categories.find((c: any) => c.slug === slug).workerCount;
    expect(count("electrical")).toBe(2);
    expect(count("ac-repair")).toBe(1);
    expect(count("plumbing")).toBe(0);
  });

  it("does not count drafts, unpublished, pending or suspended workers", async () => {
    const admin = await t.newAdmin();
    await t.createWorker({ stage: "draft" });
    await t.createWorker({ stage: "submitted" });
    await t.createWorker({ stage: "approved", admin });
    const suspended = await t.createWorker({ admin });
    await admin.agent.post(`${t.api}/admin/workers/${suspended.profileId}/suspension`).send({ suspended: true, reason: "test" });
    const res = await t.client().get(`${t.api}/categories`);
    expect(res.body.categories.find((c: any) => c.slug === "electrical").workerCount).toBe(0);
  });

  it("hides inactive categories everywhere", async () => {
    await t.prisma.serviceCategory.update({ where: { slug: "painting" }, data: { isActive: false } });
    const list = await t.client().get(`${t.api}/categories`);
    expect(list.body.categories.map((c: any) => c.slug)).not.toContain("painting");
    expect((await t.client().get(`${t.api}/categories/painting`)).status).toBe(404);
    expect((await t.client().get(`${t.api}/categories/plumbing`)).status).toBe(200);
  });

  it("returns 404 (not 500) for invalid or unknown category identifiers", async () => {
    for (const slug of ["nope", "UPPER", "a'; DROP TABLE service_category;--", "x".repeat(80)]) {
      expect((await t.client().get(`${t.api}/categories/${encodeURIComponent(slug)}`)).status).toBe(404);
    }
  });

  it("has no write endpoints: unauthorised and non-admin modifications change nothing", async () => {
    const before = await t.prisma.serviceCategory.count();
    const user = await t.signUpAndLogin("cat-user@example.com");
    const admin = await t.newAdmin();
    for (const who of [t.client(), user.agent, admin.agent]) {
      for (const [method, path] of [["post", "/categories"], ["put", "/categories/plumbing"], ["patch", "/categories/plumbing"], ["delete", "/categories/plumbing"]] as const) {
        const res = await (who as any)[method](`${t.api}${path}`).send({ name: "Hacked", slug: "hacked" });
        expect([401, 403, 404]).toContain(res.status);
      }
    }
    expect(await t.prisma.serviceCategory.count()).toBe(before);
    expect((await t.prisma.serviceCategory.findUniqueOrThrow({ where: { slug: "plumbing" } })).name).toBe("Plumbing");
  });

  it("seed is idempotent and creates no duplicate slugs", async () => {
    const dupes = await t.prisma.$queryRaw<{ slug: string }[]>`SELECT slug FROM service_category GROUP BY slug HAVING count(*) > 1`;
    expect(dupes).toHaveLength(0);
    const names = await t.prisma.$queryRaw<{ n: string }[]>`SELECT lower(name) AS n FROM service_category GROUP BY lower(name) HAVING count(*) > 1`;
    expect(names).toHaveLength(0);
  });
});

describe("public worker directory and search", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.prisma.serviceCategory.updateMany({ data: { isActive: true } });
    await t.close();
  });
  beforeEach(async () => {
    await t.resetData();
    await t.prisma.serviceCategory.updateMany({ data: { isActive: true } });
  });

  const search = (qs = "") => t.client().get(`${t.api}/workers${qs}`);
  const names = (res: any) => res.body.workers.map((w: any) => w.displayName);

  it("an empty directory is a valid empty result, not an error", async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workers: [], total: 0, totalPages: 0, page: 1, pageSize: 12 });
  });

  describe("visibility", () => {
    it("lists only approved + published + unsuspended profiles", async () => {
      const admin = await t.newAdmin();
      await t.createWorker({ displayName: "Draft Dan", stage: "draft" });
      await t.createWorker({ displayName: "Pending Pat", stage: "submitted" });
      await t.createWorker({ displayName: "Approved Ann", stage: "approved", admin });
      const gone = await t.createWorker({ displayName: "Unpublished Uma", admin });
      await gone.agent.post(`${t.api}/me/worker-profile/unpublish`).send({});
      const sus = await t.createWorker({ displayName: "Suspended Sam", admin });
      await admin.agent.post(`${t.api}/admin/workers/${sus.profileId}/suspension`).send({ suspended: true, reason: "spam" });
      await t.createWorker({ displayName: "Visible Vic", admin });

      expect(names(await search())).toEqual(["Visible Vic"]);
      // Search terms and filters cannot widen visibility.
      expect(names(await search("?q=Draft"))).toEqual([]);
      expect(names(await search("?q=Suspended&location=Dhaka&category=electrical"))).toEqual([]);
    });

    it("direct profile access is 404 and indistinguishable for hidden and unknown profiles", async () => {
      const admin = await t.newAdmin();
      const pub = await t.createWorker({ displayName: "Visible Vic", admin });
      const hidden = await t.createWorker({ displayName: "Hidden Hal", admin });
      await hidden.agent.post(`${t.api}/me/worker-profile/unpublish`).send({});
      const draft = await t.createWorker({ stage: "draft" });
      void draft;

      expect((await t.client().get(`${t.api}/workers/${pub.slug}`)).status).toBe(200);
      const a = await t.client().get(`${t.api}/workers/${hidden.slug}`);
      const b = await t.client().get(`${t.api}/workers/does-not-exist-00000000`);
      const c = await t.client().get(`${t.api}/workers/BAD_SLUG!!`);
      expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
      expect(a.body).toEqual(b.body);
      // Raw ids / emails are not valid public identifiers.
      expect((await t.client().get(`${t.api}/workers/${pub.profileId}`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/workers/${pub.email}`)).status).toBe(404);
    });
  });

  describe("privacy", () => {
    it("never returns private fields in cards or profiles", async () => {
      const w = await t.createWorker({ displayName: "Private Pete" });
      const list = await search();
      const profile = await t.client().get(`${t.api}/workers/${w.slug}`);
      for (const res of [list, profile]) {
        const text = JSON.stringify(res.body);
        for (const secret of [w.email, w.userId, "reviewNote", "suspensionReason", "reviewedById", "reviewedAt", "userId", "email", "password", "onboardingStatus", "verificationStatus", "submittedAt"]) {
          expect(text, `leaked ${secret}`).not.toContain(secret);
        }
      }
      expect(Object.keys(list.body.workers[0]).sort()).toEqual(
        ["categories", "displayName", "experienceYears", "headline", "id", "primaryCategory", "publishedAt", "rating", "reviewCount", "serviceAreas", "slug", "startingPriceBdt", "verification"].sort(),
      );
    });

    it("exposes no invented ratings", async () => {
      await t.createWorker();
      const card = (await search()).body.workers[0];
      expect(card.rating).toBeNull();
      expect(card.reviewCount).toBe(0);
    });

    it("returns worker text verbatim as JSON (rendering is the client's job) with nosniff", async () => {
      const w = await t.createWorker({ bio: "<script>alert(1)</script> Ten years of experience with wiring." });
      const res = await t.client().get(`${t.api}/workers/${w.slug}`);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.body.worker.bio).toContain("<script>");
    });
  });

  describe("text search", () => {
    beforeEach(async () => {
      const admin = await t.newAdmin();
      await t.createWorker({ admin, displayName: "Rahim Uddin", headline: "Licensed electrician", bio: "Residential wiring and fan fitting across Dhaka city.", services: [{ categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 400 }] });
      await t.createWorker({ admin, displayName: "Karim Hossain", headline: "Plumbing specialist", bio: "Leak repair and bathroom fittings, available everywhere.", services: [{ categorySlug: "plumbing", pricingModel: "HOURLY", basePriceBdt: 300 }], serviceAreas: ["Chattogram"] });
    });

    it.each([
      ["name", "rahim", ["Rahim Uddin"]],
      ["name (case-insensitive)", "KARIM", ["Karim Hossain"]],
      ["headline", "electrician", ["Rahim Uddin"]],
      ["bio", "bathroom", ["Karim Hossain"]],
      ["category name", "plumbing", ["Karim Hossain"]],
    ])("matches on %s", async (_l, q, expected) => {
      expect(names(await search(`?q=${q}`))).toEqual(expected);
    });

    it("requires every term to match (AND), in any field", async () => {
      expect(names(await search("?q=rahim+wiring"))).toEqual(["Rahim Uddin"]);
      expect(names(await search("?q=rahim+bathroom"))).toEqual([]);
    });

    it("treats empty and whitespace-only queries as no query", async () => {
      expect(await search("?q=")).toMatchObject({ status: 200, body: { total: 2 } });
      expect(await search("?q=%20%20%20")).toMatchObject({ status: 200, body: { total: 2 } });
    });

    it("treats LIKE wildcards literally and survives injection-looking input", async () => {
      for (const q of ["%", "_", "%25%25", "'; DROP TABLE worker_profile; --", "\\", "a\" OR 1=1"]) {
        const res = await search(`?q=${encodeURIComponent(q)}`);
        expect(res.status, q).toBe(200);
        expect(res.body.total, q).toBe(0);
      }
      expect((await search()).body.total).toBe(2); // table intact
    });
  });

  describe("filters", () => {
    beforeEach(async () => {
      const admin = await t.newAdmin();
      const mk = (displayName: string, extra: object) => t.createWorker({ admin, displayName, ...extra });
      await mk("Alpha", { experienceYears: 2, serviceAreas: ["Dhaka"], services: [{ categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 300 }] });
      await mk("Bravo", { experienceYears: 10, serviceAreas: ["Dhaka", "Sylhet"], services: [{ categorySlug: "plumbing", pricingModel: "HOURLY", basePriceBdt: 800 }, { categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 1200 }] });
      await mk("Charlie", { experienceYears: 20, serviceAreas: ["Khulna"], services: [{ categorySlug: "plumbing", pricingModel: "QUOTE" }] });
    });

    it("filters by category", async () => {
      expect(names(await search("?category=electrical&sort=experience"))).toEqual(["Bravo", "Alpha"]);
      expect(names(await search("?category=plumbing&sort=experience"))).toEqual(["Charlie", "Bravo"]);
    });
    it("filters by location (division)", async () => {
      expect(names(await search("?location=Sylhet"))).toEqual(["Bravo"]);
      expect(names(await search("?location=Dhaka&sort=experience"))).toEqual(["Bravo", "Alpha"]);
    });
    it("filters by max starting price; quote-only workers have no price and are excluded", async () => {
      expect(names(await search("?maxPrice=500"))).toEqual(["Alpha"]);
      expect(names(await search("?maxPrice=800&sort=price_asc"))).toEqual(["Alpha", "Bravo"]);
    });
    it("filters by minimum experience", async () => {
      expect(names(await search("?minExperience=10&sort=experience"))).toEqual(["Charlie", "Bravo"]);
    });
    it("combines filters and search", async () => {
      expect(names(await search("?category=plumbing&location=Dhaka&maxPrice=1000&minExperience=5"))).toEqual(["Bravo"]);
      expect(names(await search("?q=alpha&location=Khulna"))).toEqual([]);
    });
    it("derives starting price from the cheapest priced service", async () => {
      const bravo = (await search("?q=bravo")).body.workers[0];
      expect(bravo.startingPriceBdt).toBe(800);
    });

    it.each([
      "maxPrice=abc", "maxPrice=10", "maxPrice=99999999", "maxPrice=5.5",
      "minExperience=-1", "minExperience=99", "location=Atlantis", "location=dhaka",
      "sort=hax", "sort=publishedAt;DROP", "page=0", "page=-1", "page=abc", "page=501",
      "pageSize=0", "pageSize=49", "pageSize=100000", "category=UPPER", "category=a b",
      `q=${"x".repeat(81)}`,
    ])("rejects invalid input: %s", async (qs) => {
      const res = await search(`?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
    });

    it("ignores unknown parameters rather than using them", async () => {
      const res = await search("?userId=abc&verificationStatus=PENDING&publishedAt=null&role=ADMIN");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
    });
  });

  describe("sorting and pagination", () => {
    it("is deterministic and never repeats or skips a profile across pages", async () => {
      const admin = await t.newAdmin();
      for (let i = 0; i < 7; i++) {
        await t.createWorker({ admin, displayName: `Tied ${i}`, experienceYears: 5, services: [{ categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 500 }] });
      }
      for (const sort of ["newest", "experience", "price_asc", "price_desc"]) {
        const seen: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const res = await search(`?sort=${sort}&pageSize=3&page=${page}`);
          expect(res.body).toMatchObject({ total: 7, totalPages: 3, pageSize: 3 });
          seen.push(...res.body.workers.map((w: any) => w.id));
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
        const again: string[] = [];
        for (let page = 1; page <= 3; page++) again.push(...(await search(`?sort=${sort}&pageSize=3&page=${page}`)).body.workers.map((w: any) => w.id));
        expect(again).toEqual(seen);
      }
    });

    it("sorts by price and experience with missing values last", async () => {
      const admin = await t.newAdmin();
      await t.createWorker({ admin, displayName: "Cheap", services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 100 }] });
      await t.createWorker({ admin, displayName: "Pricey", services: [{ categorySlug: "plumbing", pricingModel: "FIXED", basePriceBdt: 900 }] });
      await t.createWorker({ admin, displayName: "Quote", services: [{ categorySlug: "plumbing", pricingModel: "QUOTE" }] });
      expect(names(await search("?sort=price_asc"))).toEqual(["Cheap", "Pricey", "Quote"]);
      expect(names(await search("?sort=price_desc"))).toEqual(["Pricey", "Cheap", "Quote"]);
    });

    it("defaults to newest first, 12 per page, and caps the page size at 48", async () => {
      const admin = await t.newAdmin();
      const first = await t.createWorker({ admin, displayName: "Older" });
      await new Promise((r) => setTimeout(r, 15));
      await t.createWorker({ admin, displayName: "Newer" });
      void first;
      expect(names(await search())).toEqual(["Newer", "Older"]);
      expect((await search()).body.pageSize).toBe(12);
      expect((await search("?pageSize=48")).status).toBe(200);
      expect((await search("?pageSize=49")).status).toBe(400);
    });

    it("returns an empty page (not an error) beyond the last page", async () => {
      await t.createWorker();
      const res = await search("?page=5");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ workers: [], total: 1, totalPages: 1, page: 5 });
    });
  });

  describe("inactive categories", () => {
    it("are not shown on cards and cannot be filtered on", async () => {
      await t.createWorker({ services: [{ categorySlug: "painting", pricingModel: "QUOTE" }, { categorySlug: "plumbing", pricingModel: "QUOTE" }] });
      await t.prisma.serviceCategory.update({ where: { slug: "painting" }, data: { isActive: false } });
      const card = (await search()).body.workers[0];
      expect(card.categories.map((c: any) => c.slug)).toEqual(["plumbing"]);
      expect((await search("?category=painting")).body.total).toBe(0);
      expect((await search("?q=painting")).body.total).toBe(0);
    });
  });
});
