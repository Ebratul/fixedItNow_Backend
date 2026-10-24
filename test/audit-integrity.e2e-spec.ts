import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("audit log integrity (database level)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  async function row() {
    const admin = await t.newAdmin();
    const created = await t.prisma.auditLog.create({ data: { actorId: admin.userId, action: "test.action", targetType: "Test", targetId: "t1", metadata: { reason: "original" } } });
    return { admin, created };
  }

  it("rejects editing an audit row", async () => {
    const { created } = await row();
    await expect(t.prisma.auditLog.update({ where: { id: created.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.auditLog.update({ where: { id: created.id }, data: { metadata: { reason: "edited" } } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.auditLog.update({ where: { id: created.id }, data: { actorId: "someone-else" } })).rejects.toThrow();
    expect(await t.prisma.auditLog.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ action: "test.action", metadata: { reason: "original" } });
  });

  it("rejects deleting audit rows, one or many", async () => {
    const { created } = await row();
    await expect(t.prisma.auditLog.delete({ where: { id: created.id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await t.prisma.auditLog.count()).toBe(1);
  });

  it("still allows appending, and deleting a user detaches the actor without changing the evidence", async () => {
    const { admin, created } = await row();
    await t.prisma.auditLog.create({ data: { actorId: admin.userId, action: "test.second", targetType: "Test", targetId: "t2" } });
    expect(await t.prisma.auditLog.count()).toBe(2);
    await t.prisma.user.delete({ where: { id: admin.userId } }); // FK ON DELETE SET NULL performs the one permitted UPDATE
    const after = await t.prisma.auditLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(after).toMatchObject({ actorId: null, action: "test.action", targetId: "t1", metadata: { reason: "original" } });
  });

  it("moderation actions are recorded and cannot be removed through the application's own database role", async () => {
    const admin = await t.newAdmin();
    const author = await t.signUpAndLogin("audit-author@example.com");
    const post = (await author.agent.post(`${t.api}/community/posts`).send({ title: "Cheap deals", body: "Call now for deals" })).body.post.id as string;
    await admin.agent.post(`${t.api}/admin/moderation/posts/${post}/visibility`).send({ hidden: true, reason: "Advertising" });
    const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { action: "content.hide" } });
    await expect(t.prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});
