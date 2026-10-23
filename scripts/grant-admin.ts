import { createScriptClient } from "./db.js";

/**
 * Trusted operator tool: grant or revoke the ADMIN role.
 *
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:grant -- someone@example.com --revoke
 *
 * This is the ONLY way to create an admin. It needs direct database access
 * (DATABASE_URL), is never reachable over HTTP, requires the user to already
 * exist with a verified email, and writes an audit-log entry.
 */
const [email, flag] = process.argv.slice(2);
if (!email || (flag && flag !== "--revoke")) {
  console.error("Usage: npm run admin:grant -- <email> [--revoke]");
  process.exit(1);
}

const prisma = createScriptClient();
try {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, emailVerified: true, role: true },
  });
  if (!user) throw new Error("No user with that email. They must sign up first.");
  if (!user.emailVerified) throw new Error("That user has not verified their email.");

  const role = flag === "--revoke" ? "USER" : "ADMIN";
  if (user.role === role) {
    console.log(`No change: user already has role ${role}.`);
  } else {
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role } }),
      prisma.auditLog.create({
        data: {
          actorId: null,
          action: role === "ADMIN" ? "admin.grant" : "admin.revoke",
          targetType: "User",
          targetId: user.id,
          metadata: { via: "operator-script" },
        },
      }),
    ]);
    console.log(`Role for ${email} is now ${role}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
