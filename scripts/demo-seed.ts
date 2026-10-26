import { seedDemo } from "../src/demo/demo.fixtures.js";
import { createScriptClient } from "./db.js";

/**
 * Operator tool: create (or top up) the fictional demo identities and data used by "Explore Demo" (docs/DEMO.md).
 *
 *   npm run demo:seed
 *   npm run demo:seed -- --allow-production      (needed when NODE_ENV=production)
 *
 * Safe to re-run: it only adds what is missing, never changes what visitors did, and touches no ordinary account. It
 * needs the migrations and the reference seed (`npm run db:deploy && npm run db:seed`). It does NOT switch anything on:
 * the three demo options stay hidden and disabled until an administrator enables them in Admin > Platform settings.
 */
const args = new Set(process.argv.slice(2));
if (process.env.NODE_ENV === "production" && !args.has("--allow-production")) {
  console.error("Refusing to seed demo data with NODE_ENV=production. Re-run with --allow-production if you really mean it.");
  process.exit(1);
}

const prisma = createScriptClient();
try {
  const host = new URL(process.env.DATABASE_URL!).host;
  console.log(`Seeding demo data into ${host} ...`);
  const summary = await seedDemo(prisma);
  console.log(`Demo realm now has ${summary.users} users, ${summary.workers} professionals and ${summary.bookings} bookings.`);
  console.log(`Created this run: ${summary.created.users} users, ${summary.created.bookings} bookings, ${summary.created.other} other records.`);
  console.log("Demo access is OFF until an administrator enables it (Admin > Platform settings > Demo access).");
} finally {
  await prisma.$disconnect();
}
