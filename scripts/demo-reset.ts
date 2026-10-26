import { seedDemo } from "../src/demo/demo.fixtures.js";
import { resetDemoData } from "../src/demo/demo.reset.js";
import { createScriptClient } from "./db.js";

/**
 * Operator tool: put the demo back to a clean, freshly dated state (docs/DEMO.md).
 *
 *   npm run demo:reset -- --yes
 *   npm run demo:reset -- --yes --allow-production      (needed when NODE_ENV=production)
 *
 * It deletes ONLY records that belong to demo accounts (bookings, chats, payments, tickets, posts, notifications,
 * profiles, sessions...), keeps the demo user rows, then runs the seed again. Ordinary users' data is never selected.
 * To delete chat messages and payment events it switches the two append-only triggers off for the length of ONE
 * transaction, which holds a lock on those tables (visitors wait for a second). Everyone in the demo is signed out.
 * Run it from a trusted machine with DATABASE_URL pointing at the right database: it is never reachable over HTTP.
 */
const args = new Set(process.argv.slice(2));
if (!args.has("--yes")) {
  console.error("This deletes every demo booking, chat message, payment and ticket, and signs all demo visitors out.\nRe-run with --yes to confirm.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && !args.has("--allow-production")) {
  console.error("Refusing to reset demo data with NODE_ENV=production. Re-run with --allow-production if you really mean it.");
  process.exit(1);
}

const prisma = createScriptClient();
try {
  console.log(`Resetting demo data in ${new URL(process.env.DATABASE_URL!).host} ...`);
  const deleted = await resetDemoData(prisma);
  console.log(`Deleted: ${Object.entries(deleted).map(([table, n]) => `${n} ${table}`).join(", ")}.`);
  const summary = await seedDemo(prisma);
  console.log(`Re-seeded: ${summary.users} users, ${summary.workers} professionals, ${summary.bookings} bookings.`);
} finally {
  await prisma.$disconnect();
}
