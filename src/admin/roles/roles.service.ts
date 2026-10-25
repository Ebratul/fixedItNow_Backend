import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, forbidden } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { canActOnRole } from "../access.js";
import { AuditService } from "../audit/audit.service.js";
import { expandPermissions, isSubset, PERMISSION_GROUPS, WILDCARD, type Permission } from "../permissions.js";
import { heldPermissions } from "../access.js";

const roleSelect = {
  id: true, key: true, name: true, description: true, permissions: true, isSystem: true, createdAt: true, updatedAt: true,
  _count: { select: { users: true } },
} satisfies Prisma.AdminRoleSelect;
type RoleRow = Prisma.AdminRoleGetPayload<{ select: typeof roleSelect }>;

const present = (r: RoleRow) => ({
  id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem,
  permissions: r.permissions.includes(WILDCARD) ? [WILDCARD] : r.permissions,
  effectivePermissions: [...expandPermissions(r.permissions)],
  holders: r._count.users,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  catalog() {
    return { groups: PERMISSION_GROUPS };
  }

  async list() {
    const rows = await this.prisma.adminRole.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }], select: roleSelect });
    return { roles: rows.map(present) };
  }

  async get(id: string) {
    const row = await this.prisma.adminRole.findUnique({
      where: { id },
      select: { ...roleSelect, users: { orderBy: { name: "asc" }, take: 100, select: { id: true, name: true, email: true, suspendedAt: true } } },
    });
    if (!row) throw new NotFoundException("Role not found");
    return {
      role: {
        ...present(row),
        users: row.users.map((u) => ({ id: u.id, name: u.name, email: u.email, suspended: u.suspendedAt !== null })),
      },
    };
  }

  private async actorRoleKey(db: Prisma.TransactionClient | PrismaService, admin: AuthContext) {
    const me = await db.user.findUnique({ where: { id: admin.userId }, select: { adminRole: { select: { key: true } } } });
    return me?.adminRole?.key ?? null;
  }

  async create(admin: AuthContext, input: { key: string; name: string; description: string; permissions: Permission[] }) {
    const wanted = new Set(input.permissions);
    if (!isSubset(wanted, heldPermissions(admin))) {
      throw forbidden("PERMISSION_ESCALATION", "You can only give a role permissions that you hold yourself");
    }
    return this.prisma.$transaction(async (tx) => {
      if (await tx.adminRole.findUnique({ where: { key: input.key }, select: { id: true } })) {
        throw conflict("ROLE_KEY_TAKEN", "A role with that key already exists");
      }
      const created = await tx.adminRole.create({
        data: { key: input.key, name: input.name, description: input.description, permissions: [...wanted].sort() },
        select: roleSelect,
      });
      await this.audit.record(tx, {
        actorId: admin.userId, action: "role.create", targetType: "AdminRole", targetId: created.id,
        metadata: { key: created.key, name: created.name, permissions: created.permissions },
      });
      return { role: present(created) };
    });
  }

  async update(admin: AuthContext, id: string, input: { name?: string; description?: string; permissions?: Permission[] }) {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.adminRole.findUnique({ where: { id }, select: roleSelect });
      if (!role) throw new NotFoundException("Role not found");
      if (role.isSystem) throw conflict("SYSTEM_ROLE", "System roles cannot be changed");
      if (!canActOnRole(admin, await this.actorRoleKey(tx, admin), role)) {
        throw forbidden("ROLE_TOO_POWERFUL", "You cannot change a role that has permissions you do not hold");
      }
      let permissions = role.permissions;
      if (input.permissions) {
        if (!isSubset(new Set(input.permissions), heldPermissions(admin))) {
          throw forbidden("PERMISSION_ESCALATION", "You can only give a role permissions that you hold yourself");
        }
        permissions = [...new Set(input.permissions)].sort();
      }
      const updated = await tx.adminRole.update({
        where: { id },
        data: { ...(input.name && { name: input.name }), ...(input.description !== undefined && { description: input.description }), permissions },
        select: roleSelect,
      });
      await this.audit.record(tx, {
        actorId: admin.userId, action: "role.update", targetType: "AdminRole", targetId: id,
        metadata: {
          key: role.key,
          added: permissions.filter((p) => !role.permissions.includes(p)),
          removed: role.permissions.filter((p) => !permissions.includes(p)),
          renamed: input.name !== undefined && input.name !== role.name,
        },
      });
      return { role: present(updated) };
    });
  }

  async remove(admin: AuthContext, id: string, confirmKey: string) {
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.adminRole.findUnique({ where: { id }, select: roleSelect });
      if (!role) throw new NotFoundException("Role not found");
      if (role.isSystem) throw conflict("SYSTEM_ROLE", "System roles cannot be deleted");
      if (confirmKey !== role.key) throw conflict("CONFIRMATION_MISMATCH", "Type the role key to confirm deletion");
      if (!canActOnRole(admin, await this.actorRoleKey(tx, admin), role)) {
        throw forbidden("ROLE_TOO_POWERFUL", "You cannot delete a role that has permissions you do not hold");
      }
      if (role._count.users > 0) {
        throw conflict("ROLE_IN_USE", `${role._count.users} administrator(s) still hold this role. Move them to another role first.`);
      }
      await tx.adminRole.delete({ where: { id } });
      await this.audit.record(tx, {
        actorId: admin.userId, action: "role.delete", targetType: "AdminRole", targetId: id,
        metadata: { key: role.key, name: role.name, permissions: role.permissions },
      });
      return { deleted: true };
    });
  }
}
