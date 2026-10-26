import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../../auth/auth.types.js";
import { conflict, forbidden } from "../../bookings/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { canActOnRole, heldPermissions, isLastSuperAdminError } from "../access.js";
import { AuditService } from "../audit/audit.service.js";
import { DEMO_ROLE_KEY } from "../../demo/demo.config.js";
import { expandPermissions, isSubset, SUPER_ADMIN_KEY } from "../permissions.js";

export type UserListQuery = {
  q?: string;
  role?: "USER" | "ADMIN";
  status?: "active" | "suspended";
  kind?: "customer" | "worker";
  page: number;
  pageSize: number;
};

const listSelect = {
  id: true, name: true, email: true, emailVerified: true, role: true, createdAt: true, suspendedAt: true,
  adminRole: { select: { id: true, key: true, name: true } },
  customerProfile: { select: { id: true } },
  workerProfile: { select: { id: true, verificationStatus: true, publishedAt: true } },
} satisfies Prisma.UserSelect;
type ListRow = Prisma.UserGetPayload<{ select: typeof listSelect }>;

const presentRow = (u: ListRow) => ({
  id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, role: u.role,
  adminRole: u.adminRole, suspended: u.suspendedAt !== null, createdAt: u.createdAt,
  isCustomer: u.customerProfile !== null,
  worker: u.workerProfile ? { id: u.workerProfile.id, verificationStatus: u.workerProfile.verificationStatus, published: u.workerProfile.publishedAt !== null } : null,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: UserListQuery) {
    const where: Prisma.UserWhereInput = {
      ...(q.q && { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }, { id: q.q }] }),
      ...(q.role && { role: q.role }),
      ...(q.status === "suspended" && { suspendedAt: { not: null } }),
      ...(q.status === "active" && { suspendedAt: null }),
      ...(q.kind === "customer" && { customerProfile: { isNot: null } }),
      ...(q.kind === "worker" && { workerProfile: { isNot: null } }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: listSelect }),
    ]);
    return { users: rows.map(presentRow), page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...listSelect, suspensionReason: true, updatedAt: true,
        customerProfile: { select: { id: true, displayName: true, preferredDivision: true } },
        _count: { select: { sessions: true, customerBookings: true, supportTickets: true, reportsFiled: true, posts: true, reviews: true } },
      },
    });
    if (!user) throw new NotFoundException("User not found");
    const [recentActions, workerBookings] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { targetType: "User", targetId: id }, orderBy: { seq: "desc" }, take: 10,
        select: { id: true, action: true, createdAt: true, metadata: true, actor: { select: { name: true } } },
      }),
      user.workerProfile ? this.prisma.booking.count({ where: { workerProfileId: user.workerProfile.id } }) : Promise.resolve(0),
    ]);
    return {
      user: {
        ...presentRow(user),
        suspensionReason: user.suspensionReason,
        updatedAt: user.updatedAt,
        customerProfile: user.customerProfile,
        activeSessions: user._count.sessions,
        counts: {
          bookingsAsCustomer: user._count.customerBookings,
          bookingsAsWorker: workerBookings,
          supportTickets: user._count.supportTickets,
          reportsFiled: user._count.reportsFiled,
          posts: user._count.posts,
          reviews: user._count.reviews,
        },
        recentActions: recentActions.map((a) => ({ id: a.id, action: a.action, createdAt: a.createdAt, by: a.actor?.name ?? "system", reason: (a.metadata as { reason?: string } | null)?.reason ?? null })),
      },
    };
  }

  /**
   * Suspend or restore an account. Suspension revokes every session in the same transaction, and
   * the auth guard and the sign-in hook then refuse the account. You cannot restrict yourself,
   * and you cannot restrict an administrator whose role is more powerful than yours.
   */
  async setSuspension(admin: AuthContext, userId: string, suspended: boolean, reason: string) {
    if (userId === admin.userId) throw forbidden("SELF_ACTION", "You cannot suspend your own account");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, suspendedAt: true, adminRole: { select: { key: true, permissions: true, isSystem: true } } },
        });
        if (!target) throw new NotFoundException("User not found");
        if (target.adminRole && !isSubset(expandPermissions(target.adminRole.permissions), heldPermissions(admin))) {
          throw forbidden("TARGET_TOO_POWERFUL", "You cannot restrict an administrator with more permissions than you");
        }
        if (target.adminRole?.key === SUPER_ADMIN_KEY && (await this.actorRoleKey(tx, admin)) !== SUPER_ADMIN_KEY) {
          throw forbidden("TARGET_TOO_POWERFUL", "Only a super administrator can restrict a super administrator");
        }
        if (suspended === (target.suspendedAt !== null)) {
          throw conflict("NO_CHANGE", suspended ? "This account is already suspended" : "This account is not suspended");
        }
        await tx.user.update({
          where: { id: userId },
          data: suspended ? { suspendedAt: new Date(), suspensionReason: reason } : { suspendedAt: null, suspensionReason: null },
        });
        let revoked = 0;
        if (suspended) revoked = (await tx.session.deleteMany({ where: { userId } })).count;
        await this.audit.record(tx, {
          actorId: admin.userId, action: suspended ? "user.suspend" : "user.restore", targetType: "User", targetId: userId,
          metadata: { reason, signedOutDevices: revoked, targetRole: target.role },
        });
        return { id: userId, suspended };
      });
    } catch (error) {
      if (isLastSuperAdminError(error)) throw conflict("LAST_SUPER_ADMIN", "The last active super administrator cannot be suspended");
      throw error;
    }
  }

  private async actorRoleKey(tx: Prisma.TransactionClient, admin: AuthContext) {
    return (await tx.user.findUnique({ where: { id: admin.userId }, select: { adminRole: { select: { key: true } } } }))?.adminRole?.key ?? null;
  }

  /**
   * Give a user admin access with a role, change their role, or (roleId = null) remove admin
   * access. The ONLY HTTP path that can create an administrator; it needs `admins.assign`, never
   * works on yourself, never hands out a role more powerful than the caller, and the target must
   * have a verified, unsuspended account.
   */
  async setAdminAccess(admin: AuthContext, userId: string, roleId: string | null, reason: string) {
    if (userId === admin.userId) throw forbidden("SELF_ACTION", "You cannot change your own admin access");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const actorKey = await this.actorRoleKey(tx, admin);
        const target = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, emailVerified: true, suspendedAt: true, adminRole: { select: { id: true, key: true, permissions: true, isSystem: true } } },
        });
        if (!target) throw new NotFoundException("User not found");
        // The target's CURRENT access must not be more powerful than the caller either.
        if (target.adminRole && !canActOnRole(admin, actorKey, target.adminRole)) {
          throw forbidden("TARGET_TOO_POWERFUL", "You cannot change an administrator who has more permissions than you");
        }
        if (roleId === null) {
          if (target.role !== "ADMIN") throw conflict("NOT_ADMIN", "This user is not an administrator");
          await tx.user.update({ where: { id: userId }, data: { role: "USER", adminRoleId: null } });
          await this.audit.record(tx, { actorId: admin.userId, action: "admin.revoke", targetType: "User", targetId: userId, metadata: { reason, roleKey: target.adminRole?.key ?? null } });
          return { id: userId, role: "USER" as const, adminRole: null };
        }
        const role = await tx.adminRole.findUnique({ where: { id: roleId }, select: { id: true, key: true, name: true, permissions: true, isSystem: true } });
        if (!role) throw new NotFoundException("Role not found");
        // The demo administrator's role belongs to the public demo identity alone (the database refuses it elsewhere too).
        if (role.key === DEMO_ROLE_KEY) throw forbidden("DEMO_ROLE", "This role is reserved for the demo administrator");
        if (!canActOnRole(admin, actorKey, role)) {
          throw forbidden("ROLE_TOO_POWERFUL", "You can only assign roles whose permissions you hold yourself");
        }
        if (!target.emailVerified) throw conflict("EMAIL_NOT_VERIFIED", "The user has not verified their email address");
        if (target.suspendedAt) throw conflict("USER_SUSPENDED", "A suspended account cannot be made an administrator");
        if (target.role === "ADMIN" && target.adminRole?.id === role.id) throw conflict("NO_CHANGE", "The user already has this role");
        await tx.user.update({ where: { id: userId }, data: { role: "ADMIN", adminRoleId: role.id } });
        await this.audit.record(tx, {
          actorId: admin.userId, action: target.role === "ADMIN" ? "admin.change_role" : "admin.grant", targetType: "User", targetId: userId,
          metadata: { reason, from: target.adminRole?.key ?? null, to: role.key },
        });
        return { id: userId, role: "ADMIN" as const, adminRole: { id: role.id, key: role.key, name: role.name } };
      });
    } catch (error) {
      if (isLastSuperAdminError(error)) throw conflict("LAST_SUPER_ADMIN", "The last active super administrator cannot be removed");
      throw error;
    }
  }
}
