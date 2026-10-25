import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, isUniqueViolation, unprocessable } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

type Tx = Prisma.TransactionClient;

export type CategoryCreate = { name: string; slug?: string; description: string; parentId?: string | null; sortOrder?: number; isActive?: boolean };
export type CategoryPatch = { name?: string; description?: string; sortOrder?: number; isActive?: boolean; parentId?: string | null };

export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");

const select = {
  id: true, slug: true, name: true, description: true, sortOrder: true, isActive: true, parentId: true, createdAt: true, updatedAt: true,
  _count: { select: { workerServices: true, bookings: true, children: true } },
} satisfies Prisma.ServiceCategorySelect;
type Row = Prisma.ServiceCategoryGetPayload<{ select: typeof select }>;

const present = (r: Row) => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, sortOrder: r.sortOrder, isActive: r.isActive, parentId: r.parentId,
  workers: r._count.workerServices, bookings: r._count.bookings, subcategories: r._count.children,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

@Injectable()
export class CategoriesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everything, including inactive categories, as a two-level tree with real usage counts. */
  async tree() {
    const rows = await this.prisma.serviceCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select });
    const parents = rows.filter((r) => r.parentId === null);
    return {
      categories: parents.map((p) => ({ ...present(p), children: rows.filter((c) => c.parentId === p.id).map(present) })),
    };
  }

  private async load(tx: Tx, id: string) {
    const row = await tx.serviceCategory.findUnique({ where: { id }, select });
    if (!row) throw new NotFoundException("Category not found");
    return row;
  }

  /** The parent of a (sub)category must be an existing top-level category. */
  private async checkParent(tx: Tx, parentId: string, becomingActive: boolean) {
    const parent = await tx.serviceCategory.findUnique({ where: { id: parentId }, select: { id: true, parentId: true, isActive: true } });
    if (!parent) throw unprocessable("PARENT_NOT_FOUND", "The parent category does not exist");
    if (parent.parentId !== null) throw unprocessable("TOO_DEEP", "Subcategories can only be one level deep");
    if (becomingActive && !parent.isActive) throw unprocessable("PARENT_INACTIVE", "Activate the parent category first");
    return parent;
  }

  async create(admin: AuthContext, input: CategoryCreate) {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw unprocessable("SLUG_REQUIRED", "Give this category a slug (letters, digits and hyphens)");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const isActive = input.isActive ?? true;
        if (input.parentId) await this.checkParent(tx, input.parentId, isActive);
        const created = await tx.serviceCategory.create({
          data: { slug, name: input.name, description: input.description, parentId: input.parentId ?? null, isActive, sortOrder: input.sortOrder ?? (await this.nextSort(tx, input.parentId ?? null)) },
          select,
        });
        await this.audit.record(tx, {
          actorId: admin.userId, action: "category.create", targetType: "ServiceCategory", targetId: created.id,
          metadata: { slug, name: created.name, parentId: created.parentId, isActive },
        });
        return { category: present(created) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "A category with that slug already exists");
      throw error;
    }
  }

  private async nextSort(tx: Tx, parentId: string | null) {
    const last = await tx.serviceCategory.aggregate({ where: { parentId }, _max: { sortOrder: true } });
    return (last._max.sortOrder ?? -1) + 1;
  }

  async update(admin: AuthContext, id: string, patch: CategoryPatch) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, id);
      const next = {
        isActive: patch.isActive ?? before.isActive,
        parentId: patch.parentId === undefined ? before.parentId : patch.parentId,
      };
      if (next.parentId !== before.parentId) {
        if (next.parentId === id) throw unprocessable("OWN_PARENT", "A category cannot be its own parent");
        if (next.parentId !== null) {
          if (before._count.children > 0) throw unprocessable("HAS_SUBCATEGORIES", "A category that has subcategories cannot become a subcategory");
          await this.checkParent(tx, next.parentId, next.isActive);
        }
      } else if (next.parentId !== null && next.isActive && !before.isActive) {
        await this.checkParent(tx, next.parentId, true);
      }
      if (before.isActive && !next.isActive) {
        const activeChildren = await tx.serviceCategory.count({ where: { parentId: id, isActive: true } });
        if (activeChildren > 0) throw conflict("HAS_ACTIVE_SUBCATEGORIES", `Deactivate its ${activeChildren} active subcategor${activeChildren === 1 ? "y" : "ies"} first`);
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const data: Prisma.ServiceCategoryUncheckedUpdateInput = {};
      if (patch.name !== undefined && patch.name !== before.name) { data.name = patch.name; changes.name = { from: before.name, to: patch.name }; }
      if (patch.description !== undefined && patch.description !== before.description) { data.description = patch.description; changes.description = { from: "(changed)", to: "(changed)" }; }
      if (patch.sortOrder !== undefined && patch.sortOrder !== before.sortOrder) { data.sortOrder = patch.sortOrder; changes.sortOrder = { from: before.sortOrder, to: patch.sortOrder }; }
      if (next.isActive !== before.isActive) { data.isActive = next.isActive; changes.isActive = { from: before.isActive, to: next.isActive }; }
      if (next.parentId !== before.parentId) { data.parentId = next.parentId; changes.parentId = { from: before.parentId, to: next.parentId }; }
      if (Object.keys(changes).length === 0) throw conflict("NO_CHANGE", "Nothing to change");
      const updated = await tx.serviceCategory.update({ where: { id }, data, select });
      await this.audit.record(tx, {
        actorId: admin.userId,
        action: "isActive" in changes ? (next.isActive ? "category.activate" : "category.deactivate") : "category.update",
        targetType: "ServiceCategory", targetId: id,
        metadata: { slug: before.slug, changes, affectedWorkers: before._count.workerServices },
      });
      return { category: present(updated) };
    });
  }

  /** Sets the display order of ALL siblings under one parent (null = top level) in one step. */
  async reorder(admin: AuthContext, parentId: string | null, ids: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const siblings = await tx.serviceCategory.findMany({ where: { parentId }, select: { id: true } });
      const have = new Set(siblings.map((s) => s.id));
      if (new Set(ids).size !== ids.length || ids.length !== have.size || !ids.every((id) => have.has(id))) {
        throw unprocessable("ORDER_MISMATCH", "List every category at this level exactly once");
      }
      for (const [index, id] of ids.entries()) await tx.serviceCategory.update({ where: { id }, data: { sortOrder: index } });
      await this.audit.record(tx, { actorId: admin.userId, action: "category.reorder", targetType: "ServiceCategory", targetId: parentId ?? "root", metadata: { count: ids.length } });
      return this.tree();
    });
  }

  /** Only a category nothing refers to can be deleted; anything else is deactivated instead. */
  async remove(admin: AuthContext, id: string, confirmSlug: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.load(tx, id);
      if (confirmSlug !== row.slug) throw conflict("CONFIRMATION_MISMATCH", "Type the category slug to confirm deletion");
      if (row._count.workerServices + row._count.bookings + row._count.children > 0) {
        throw conflict("CATEGORY_IN_USE", `Used by ${row._count.workerServices} worker service(s), ${row._count.bookings} booking(s) and ${row._count.children} subcategorie(s). Deactivate it instead.`);
      }
      await tx.serviceCategory.delete({ where: { id } });
      await this.audit.record(tx, { actorId: admin.userId, action: "category.delete", targetType: "ServiceCategory", targetId: id, metadata: { slug: row.slug, name: row.name } });
      return { deleted: true };
    });
  }
}
