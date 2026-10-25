import { createScriptClient } from "./db.js";

/**
 * Trusted operator tool: grant, change or revoke admin access.
 *
 *   npm run admin:grant -- someone@example.com                      (super_admin)
 *   npm run admin:grant -- someone@example.com --role finance_admin
 *   npm run admin:grant -- someone@example.com --revoke
 *
 * This is the bootstrap path for the FIRST administrator (afterwards, admins with the
 * `admins.assign` permission can do it in the panel). It needs direct database access
 * (DATABASE_URL), is never reachable over HTTP, requires the user to already exist with a verified
 * email, and writes an audit-log entry.
 */
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const revoke = args.includes("--revoke");
const roleIndex = args.indexOf("--role");
const roleKey = roleIndex >= 0 ? args[roleIndex + 1] : "super_admin";
const known = new Set(["--revoke", "--role", roleKey]);
if (!email || args.some((a) => a.startsWith("--") && !known.has(a)) || (roleIndex >= 0 && (!roleKey || roleKey.startsWith("--")))) {
  console.error("Usage: npm run admin:grant -- <email> [--role <role-key>] [--revoke]");
  process.exit(1);
}

const prisma = createScriptClient();
try {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, emailVerified: true, role: true, adminRole: { select: { key: true } } },
  });
  if (!user) throw new Error("No user with that email. They must sign up first.");
  if (!user.emailVerified) throw new Error("That user has not verified their email.");

  if (revoke) {
    if (user.role !== "ADMIN") {
      console.log("No change: user is not an administrator.");
    } else {
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { role: "USER", adminRoleId: null } }),
        prisma.auditLog.create({ data: { actorId: null, action: "admin.revoke", targetType: "User", targetId: user.id, metadata: { via: "operator-script", roleKey: user.adminRole?.key ?? null } } }),
      ]);
      console.log(`Admin access for ${email} removed.`);
    }
  } else {
    const role = await prisma.adminRole.findUnique({ where: { key: roleKey } });
    if (!role) throw new Error(`No admin role with key "${roleKey}". Run the seed (npm run db:seed) or create it in the panel.`);
    if (user.role === "ADMIN" && user.adminRole?.key === role.key) {
      console.log(`No change: user already has role ${role.key}.`);
    } else {
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN", adminRoleId: role.id } }),
        prisma.auditLog.create({
          data: { actorId: null, action: user.role === "ADMIN" ? "admin.change_role" : "admin.grant", targetType: "User", targetId: user.id, metadata: { via: "operator-script", from: user.adminRole?.key ?? null, to: role.key } },
        }),
      ]);
      console.log(`${email} is now an administrator with role ${role.key}.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
