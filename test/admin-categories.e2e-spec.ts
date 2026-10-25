import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slugify } from "../src/admin/categories/categories.service.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("admin service catalogue", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());
  // Categories are reference data that resetData keeps; remove what these tests create.
  afterEach(async () => {
    await t.resetData(); // worker services / bookings reference categories
    await t.prisma.serviceCategory.deleteMany({ where: { slug: { startsWith: "zt-" }, parentId: { not: null } } });
    await t.prisma.serviceCategory.deleteMany({ where: { slug: { startsWith: "zt-" } } });
    await t.prisma.serviceCategory.updateMany({ data: { isActive: true } });
  });

  const create = (a: { agent: { post: (u: string) => { send: (b: object) => Promise<{ status: number; body: Record<string, any> }> } } }, body: object) => a.agent.post(`${t.api}/admin/categories`).send(body);
  const base = { name: "ZT Gardening", slug: "zt-gardening", description: "Lawns and plants" };

  it("slugify handles ordinary and non-latin names", () => {
    expect(slugify("AC Repair & Servicing")).toBe("ac-repair-servicing");
    expect(slugify("  Moving   &   Shifting!! ")).toBe("moving-shifting");
    expect(slugify("রংমিস্ত্রি")).toBe("");
  });

  it("lists the tree including inactive categories, with real usage counts", async () => {
    const admin = await t.newAdmin();
    const w = await t.createWorker({ stage: "published", admin });
    await t.prisma.serviceCategory.update({ where: { slug: "painting" }, data: { isActive: false } });
    const tree = await admin.agent.get(`${t.api}/admin/categories`);
    expect(tree.status).toBe(200);
    const electrical = tree.body.categories.find((c: { slug: string }) => c.slug === "electrical");
    expect(electrical).toMatchObject({ workers: 1, bookings: 0, subcategories: 0, isActive: true, children: [] });
    expect(tree.body.categories.find((c: { slug: string }) => c.slug === "painting").isActive).toBe(false);
    expect(w.profileId).toBeDefined();
  });

  describe("create", () => {
    it("creates top-level and sub categories, derives a slug, and audits both", async () => {
      const admin = await t.newAdmin();
      const parent = await create(admin, base);
      expect(parent.status).toBe(201);
      expect(parent.body.category).toMatchObject({ slug: "zt-gardening", isActive: true, parentId: null });
      const child = await create(admin, { name: "ZT Lawn Mowing", description: "Mowing", parentId: parent.body.category.id });
      expect(child.status).toBe(201);
      expect(child.body.category.slug).toBe("zt-lawn-mowing");
      expect(child.body.category.parentId).toBe(parent.body.category.id);
      const trail = await t.prisma.auditLog.findMany({ where: { action: "category.create" }, orderBy: { seq: "asc" } });
      expect(trail).toHaveLength(2);
      expect(trail[1]).toMatchObject({ actorId: admin.userId });
    });

    it("validates input and enforces uniqueness and depth", async () => {
      const admin = await t.newAdmin();
      const bad = [
        { ...base, name: "x" }, { ...base, slug: "Bad Slug" }, { ...base, slug: "-lead" }, { ...base, description: "" },
        { ...base, parentId: "nope" }, { ...base, sortOrder: -1 }, { ...base, isActive: "yes" }, { ...base, extra: 1 },
        { ...base, name: "Bad\u0007Name" }, { ...base, slug: "a".repeat(51) },
      ];
      for (const body of bad) expect((await create(admin, body)).status, JSON.stringify(body)).toBe(400);
      expect((await create(admin, { name: "রংমিস্ত্রি", description: "d" })).body.code).toBe("SLUG_REQUIRED");
      const ok = await create(admin, base);
      expect((await create(admin, base)).body.code).toBe("SLUG_TAKEN");
      const child = await create(admin, { name: "ZT Child", slug: "zt-child", description: "d", parentId: ok.body.category.id });
      expect((await create(admin, { name: "ZT Grandchild", slug: "zt-grandchild", description: "d", parentId: child.body.category.id })).body.code).toBe("TOO_DEEP");
      expect((await create(admin, { name: "ZT Orphan", slug: "zt-orphan", description: "d", parentId: "0192a000-0000-7000-8000-000000000000" })).body.code).toBe("PARENT_NOT_FOUND");
    });

    it("needs catalog.manage; catalog.read only reads", async () => {
      const reader = await t.newAdminWith(["catalog.read"]);
      expect((await reader.agent.get(`${t.api}/admin/categories`)).status).toBe(200);
      expect((await create(reader, base)).status).toBe(403);
      const nobody = await t.newAdminWith(["users.read"]);
      expect((await nobody.agent.get(`${t.api}/admin/categories`)).status).toBe(403);
      expect(await t.prisma.serviceCategory.count({ where: { slug: "zt-gardening" } })).toBe(0);
    });
  });

  describe("update", () => {
    it("edits name, description, order and parent; the slug never changes", async () => {
      const admin = await t.newAdmin();
      const a = (await create(admin, base)).body.category;
      const b = (await create(admin, { name: "ZT Cooking", slug: "zt-cooking", description: "d" })).body.category;
      const patch = (id: string, body: object) => admin.agent.patch(`${t.api}/admin/categories/${id}`).send(body);
      const renamed = await patch(a.id, { name: "ZT Garden Care", description: "Everything green", sortOrder: 50 });
      expect(renamed.body.category).toMatchObject({ slug: "zt-gardening", name: "ZT Garden Care", sortOrder: 50 });
      expect((await patch(a.id, { slug: "zt-new" })).status).toBe(400);
      expect((await patch(a.id, {})).status).toBe(400);
      expect((await patch(a.id, { name: "ZT Garden Care" })).body.code).toBe("NO_CHANGE");
      expect((await patch(a.id, { parentId: a.id })).body.code).toBe("OWN_PARENT");
      const moved = await patch(b.id, { parentId: a.id });
      expect(moved.body.category.parentId).toBe(a.id);
      expect((await patch(a.id, { parentId: b.id })).body.code).toBe("HAS_SUBCATEGORIES"); // a has a child now
      const promoted = await patch(b.id, { parentId: null });
      expect(promoted.body.category.parentId).toBeNull();
      const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "category.update", targetId: a.id } });
      expect(entry.metadata).toMatchObject({ slug: "zt-gardening", changes: { name: { from: "ZT Gardening", to: "ZT Garden Care" } } });
    });

    it("keeps hierarchy and activity consistent (service rules and database triggers)", async () => {
      const admin = await t.newAdmin();
      const parent = (await create(admin, base)).body.category;
      const child = (await create(admin, { name: "ZT Sub", slug: "zt-sub", description: "d", parentId: parent.id })).body.category;
      const patch = (id: string, body: object) => admin.agent.patch(`${t.api}/admin/categories/${id}`).send(body);
      expect((await patch(parent.id, { isActive: false })).body.code).toBe("HAS_ACTIVE_SUBCATEGORIES");
      expect((await patch(child.id, { isActive: false })).status).toBe(200);
      expect((await patch(parent.id, { isActive: false })).status).toBe(200);
      expect((await patch(child.id, { isActive: true })).body.code).toBe("PARENT_INACTIVE");
      expect((await create(admin, { name: "ZT Sub Two", slug: "zt-sub-two", description: "d", parentId: parent.id })).body.code).toBe("PARENT_INACTIVE");
      expect((await patch(parent.id, { isActive: true })).status).toBe(200);
      expect((await patch(child.id, { isActive: true })).status).toBe(200);
      const actions = (await t.prisma.auditLog.findMany({ where: { action: { startsWith: "category." } }, orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["category.deactivate", "category.activate"]));

      // the same rules hold for anyone writing to the table directly
      await expect(t.prisma.serviceCategory.update({ where: { id: parent.id }, data: { isActive: false } })).rejects.toThrow(/subcategories/);
      await expect(t.prisma.serviceCategory.update({ where: { id: child.id }, data: { parentId: child.id } })).rejects.toThrow();
      const other = await t.prisma.serviceCategory.create({ data: { slug: "zt-direct", name: "Direct", description: "d" } });
      await expect(t.prisma.serviceCategory.update({ where: { id: other.id }, data: { parentId: child.id } })).rejects.toThrow(/subcategories/);
    });
  });

  describe("public effect", () => {
    it("nests active subcategories, rolls worker counts up, hides inactive ones everywhere, and searches by parent", async () => {
      const admin = await t.newAdmin();
      const parent = (await create(admin, base)).body.category;
      const sub = (await create(admin, { name: "ZT Lawn", slug: "zt-lawn", description: "d", parentId: parent.id })).body.category;
      const w = await t.createWorker({ stage: "draft", admin, services: [{ categorySlug: "zt-lawn", pricingModel: "FIXED", basePriceBdt: 300 }] as never });
      await w.agent.post(`${t.api}/me/worker-profile/submit`).send({});
      await admin.agent.post(`${t.api}/admin/workers/${w.profileId}/verification`).send({ decision: "VERIFIED" });
      const published = await w.agent.post(`${t.api}/me/worker-profile/publish`).send({});
      expect(published.status).toBe(200);

      const list = await t.client().get(`${t.api}/categories`);
      const pub = list.body.categories.find((c: { slug: string }) => c.slug === "zt-gardening");
      expect(pub.workerCount).toBe(1); // counted once via its subcategory
      expect(pub.subcategories).toEqual([expect.objectContaining({ slug: "zt-lawn", workerCount: 1 })]);
      expect(list.body.categories.some((c: { slug: string }) => c.slug === "zt-lawn")).toBe(false); // subcategories are nested, not top-level
      const detail = await t.client().get(`${t.api}/categories/zt-lawn`);
      expect(detail.body.category).toMatchObject({ slug: "zt-lawn", parent: { slug: "zt-gardening" } });
      for (const slug of ["zt-gardening", "zt-lawn"]) {
        const found = await t.client().get(`${t.api}/workers?category=${slug}`);
        expect(found.body.total, slug).toBe(1);
      }

      await admin.agent.patch(`${t.api}/admin/categories/${sub.id}`).send({ isActive: false });
      expect((await t.client().get(`${t.api}/categories/zt-lawn`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/categories`)).body.categories.find((c: { slug: string }) => c.slug === "zt-gardening").subcategories).toEqual([]);
      expect((await t.client().get(`${t.api}/workers?category=zt-lawn`)).body.total).toBe(0);
      expect((await t.client().get(`${t.api}/workers?category=zt-gardening`)).body.total).toBe(0);
      // and nobody can start a booking in an inactive category
      const customer = await t.signUpAndLogin("cust-cat@example.com");
      const booking = await customer.agent.post(`${t.api}/bookings`).set("Idempotency-Key", "cat-key-000001").send({ workerSlug: w.slug, categorySlug: "zt-lawn" });
      expect([400, 404, 409, 422]).toContain(booking.status);
    });

    it("deactivating a top-level category removes it from the public site", async () => {
      const admin = await t.newAdmin();
      const electrical = await t.prisma.serviceCategory.findUniqueOrThrow({ where: { slug: "electrical" } });
      expect((await t.client().get(`${t.api}/categories/electrical`)).status).toBe(200);
      expect((await admin.agent.patch(`${t.api}/admin/categories/${electrical.id}`).send({ isActive: false })).status).toBe(200);
      expect((await t.client().get(`${t.api}/categories/electrical`)).status).toBe(404);
      expect((await t.client().get(`${t.api}/categories`)).body.categories.map((c: { slug: string }) => c.slug)).not.toContain("electrical");
    });
  });

  describe("reorder and delete", () => {
    it("reorders all siblings at once and the public list follows", async () => {
      const admin = await t.newAdmin();
      const tree = (await admin.agent.get(`${t.api}/admin/categories`)).body.categories as { id: string; slug: string }[];
      const reversed = [...tree].reverse().map((c) => c.id);
      const res = await admin.agent.put(`${t.api}/admin/categories/order`).send({ parentId: null, ids: reversed });
      expect(res.status).toBe(200);
      expect((await t.client().get(`${t.api}/categories`)).body.categories[0].slug).toBe(tree[tree.length - 1]!.slug);
      expect((await admin.agent.put(`${t.api}/admin/categories/order`).send({ parentId: null, ids: reversed.slice(1) })).body.code).toBe("ORDER_MISMATCH");
      expect((await admin.agent.put(`${t.api}/admin/categories/order`).send({ parentId: null, ids: [reversed[0], reversed[0]] })).status).toBe(422);
      // restore the seed order for later tests
      await admin.agent.put(`${t.api}/admin/categories/order`).send({ parentId: null, ids: tree.map((c) => c.id) });
    });

    it("deletes only unused categories, after typing the slug", async () => {
      const admin = await t.newAdmin();
      const c = (await create(admin, base)).body.category;
      const del = (id: string, confirmSlug: string) => admin.agent.delete(`${t.api}/admin/categories/${id}`).send({ confirmSlug });
      expect((await del(c.id, "wrong")).body.code).toBe("CONFIRMATION_MISMATCH");
      const electrical = await t.prisma.serviceCategory.findUniqueOrThrow({ where: { slug: "electrical" } });
      await t.createWorker({ stage: "draft", admin });
      const inUse = await del(electrical.id, "electrical");
      expect(inUse.status).toBe(409);
      expect(inUse.body.code).toBe("CATEGORY_IN_USE");
      expect(await t.prisma.serviceCategory.count({ where: { slug: "electrical" } })).toBe(1);
      await create(admin, { name: "ZT Kid", slug: "zt-kid", description: "d", parentId: c.id });
      expect((await del(c.id, "zt-gardening")).body.code).toBe("CATEGORY_IN_USE"); // has a subcategory
      const kid = await t.prisma.serviceCategory.findUniqueOrThrow({ where: { slug: "zt-kid" } });
      expect((await del(kid.id, "zt-kid")).status).toBe(200);
      expect((await del(c.id, "zt-gardening")).status).toBe(200);
      expect((await t.prisma.auditLog.findMany({ where: { action: "category.delete" } })).length).toBe(2);
      expect((await del(c.id, "zt-gardening")).status).toBe(404);
    });
  });
});
