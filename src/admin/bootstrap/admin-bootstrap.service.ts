import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AUTH, type Auth } from "../../auth/auth.factory.js";
import { ENV, type Env } from "../../config/env.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { normalizeEmail } from "../../auth/otp.js";
import { AuditService } from "../audit/audit.service.js";
import { SUPER_ADMIN_KEY } from "../permissions.js";

/**
 * Creates the administrator named by ADMIN_EMAIL / ADMIN_PASSWORD at startup, so the first admin can
 * sign in on /admin without a manual database step. The env file is the source of truth for that
 * account: its email is marked verified, it gets the super_admin role, and its password is
 * (re)set when it does not match. Does nothing when the variables are unset. A failure is logged and
 * never stops the API from starting.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap() {
    if (!this.env.ADMIN_EMAIL || !this.env.ADMIN_PASSWORD || this.env.NODE_ENV === "test") return;
    try {
      await this.ensureAdmin(normalizeEmail(this.env.ADMIN_EMAIL), this.env.ADMIN_PASSWORD);
    } catch (error) {
      this.logger.error(`Could not set up the ADMIN_EMAIL administrator: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async ensureAdmin(email: string, password: string) {
    const { password: hasher } = await this.auth.$context;
    const role = await this.prisma.adminRole.findUnique({ where: { key: SUPER_ADMIN_KEY }, select: { id: true } });
    if (!role) throw new Error("the super_admin role is missing (run the database migrations)");

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerified: true, role: true, adminRoleId: true, suspendedAt: true, accounts: { where: { providerId: "credential" }, select: { id: true, password: true } } },
    });

    const changes: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      let userId = existing?.id;
      if (!existing) {
        userId = randomUUID();
        await tx.user.create({
          data: { id: userId, email, name: "Administrator", emailVerified: true, role: "ADMIN", adminRoleId: role.id },
        });
        changes.push("created");
      } else if (!existing.emailVerified || existing.role !== "ADMIN" || existing.adminRoleId !== role.id) {
        await tx.user.update({ where: { id: existing.id }, data: { emailVerified: true, role: "ADMIN", adminRoleId: role.id } });
        changes.push("granted super_admin");
      }

      const credential = existing?.accounts[0];
      const passwordOk = credential?.password ? await hasher.verify({ hash: credential.password, password }) : false;
      if (!passwordOk) {
        const hash = await hasher.hash(password);
        if (credential) await tx.account.update({ where: { id: credential.id }, data: { password: hash } });
        else await tx.account.create({ data: { id: randomUUID(), accountId: userId!, providerId: "credential", userId: userId!, password: hash } });
        // A changed password signs out every older session.
        if (existing) await tx.session.deleteMany({ where: { userId: userId! } });
        changes.push("password set");
      }

      if (changes.length > 0) {
        await this.audit.record(tx, { actorId: null, action: changes[0] === "created" ? "admin.grant" : "admin.change_role", targetType: "User", targetId: userId!, metadata: { via: "env-bootstrap", changes } });
      }
    });

    if (changes.length > 0) this.logger.log(`Administrator ${email}: ${changes.join(", ")}.`);
    if (existing?.suspendedAt) this.logger.warn(`Administrator ${email} is suspended and cannot sign in.`);
  }
}
