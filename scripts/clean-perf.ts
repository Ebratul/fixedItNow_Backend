import { Prisma } from "../src/generated/prisma/client.js";
import { createScriptClient } from "./db.js";
import { PERF_EMAIL_DOMAIN, PERF_KEY_PREFIX, PERF_MARKER, guardDatabase, parseArgs } from "./perf-common.js";

/**
 * Removes everything scripts/seed-perf.ts wrote, and nothing else.
 *
 *   npm run perf:clean                  delete the performance data
 *   npm run perf:clean -- --dry-run     show what would be deleted, change nothing (runs and rolls back)
 *   npm run perf:clean -- --keep-audit  leave the performance audit entries in place (actor ids are detached)
 *   npm run perf:clean -- --rechain     also needed when real audit entries were written AFTER the seed (see below)
 *
 * Found by the markers in scripts/perf-common.ts. A booking counts as performance data when it is marked, or when
 * both its customer and its professional are performance users; anything that hangs off it goes with it. If a REAL
 * booking or payment points at a performance user, the script stops and changes nothing.
 *
 * Two tables are append-only by design (database triggers): payment_event and audit_log (and chat_message). The seed
 * writes no payment or chat events, but someone testing on the seeded data may have created some, so for the
 * performance rows ONLY the guard triggers are switched off inside the transaction and switched back on before it
 * commits (needs the table owner, i.e. a local/dev database). audit_log is also a hash chain:
 *   - performance rows at the END of the chain (nothing real written after the seed): deleting them leaves a valid
 *     chain, it simply ends earlier;
 *   - real rows written after the seed: deleting the performance rows would leave gaps, so the script refuses unless
 *     --rechain is given, which renumbers and re-hashes the rows after the first deleted one (the same procedure as
 *     the migration backfill). That rewrites the hashes of those real rows: fine on a test database, never on one
 *     whose audit head hash is anchored somewhere.
 * Everything runs in ONE transaction: any error leaves the database exactly as it was.
 */

const args = parseArgs();
const host = guardDatabase(args, "remove performance data");
const dryRun = args.flags.has("dry-run");
const keepAudit = args.flags.has("keep-audit");
const rechain = args.flags.has("rechain");

const emailLike = `%@${PERF_EMAIL_DOMAIN}`;
const keyLike = `${PERF_KEY_PREFIX}%`;

class Rollback extends Error {}
class Refusal extends Error {}

type Tx = Prisma.TransactionClient;
const count = async (tx: Tx, sql: Prisma.Sql) => Number((await tx.$queryRaw<{ n: bigint }[]>(sql))[0]!.n);

/** DELETE with an append-only guard trigger switched off for this statement only (no-op when nothing matches). */
async function deleteGuarded(tx: Tx, table: string, trigger: string, where: Prisma.Sql): Promise<number> {
  const n = await count(tx, Prisma.sql`SELECT count(*) AS n FROM ${Prisma.raw(`"${table}"`)} WHERE ${where}`);
  if (n === 0) return 0;
  await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  const deleted = await tx.$executeRaw`DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE ${where}`;
  await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  return deleted;
}

const prisma = createScriptClient();
const removed: Record<string, number> = {};
try {
  console.log(`${dryRun ? "[dry run] " : ""}Removing performance data from ${host} ...`);
  await prisma
    .$transaction(
      async (tx) => {
        // Working sets, dropped automatically at the end of the transaction.
        await tx.$executeRaw`CREATE TEMP TABLE perf_users ON COMMIT DROP AS SELECT "id" FROM "user" WHERE "email" LIKE ${emailLike}`;
        await tx.$executeRaw`CREATE TEMP TABLE perf_workers ON COMMIT DROP AS SELECT "id" FROM "worker_profile" WHERE "userId" IN (SELECT "id" FROM perf_users)`;
        await tx.$executeRaw`
          CREATE TEMP TABLE perf_bookings ON COMMIT DROP AS SELECT "id" FROM "booking"
          WHERE "idempotencyKey" LIKE ${keyLike}
             OR ("customerId" IN (SELECT "id" FROM perf_users) AND "workerProfileId" IN (SELECT "id" FROM perf_workers))`;
        await tx.$executeRaw`
          CREATE TEMP TABLE perf_payments ON COMMIT DROP AS SELECT "id" FROM "payment"
          WHERE "idempotencyKey" LIKE ${keyLike} OR "bookingId" IN (SELECT "id" FROM perf_bookings)`;

        // Real data that points at performance users: stop rather than guess.
        const realBookings = await count(tx, Prisma.sql`
          SELECT count(*) AS n FROM "booking" WHERE "id" NOT IN (SELECT "id" FROM perf_bookings)
            AND ("customerId" IN (SELECT "id" FROM perf_users) OR "workerProfileId" IN (SELECT "id" FROM perf_workers))`);
        const realPayments = await count(tx, Prisma.sql`
          SELECT count(*) AS n FROM "payment" WHERE "id" NOT IN (SELECT "id" FROM perf_payments) AND "customerId" IN (SELECT "id" FROM perf_users)`);
        if (realBookings + realPayments > 0) {
          throw new Refusal(
            `${realBookings} real booking(s) and ${realPayments} real payment(s) involve performance users (someone booked a seeded professional?). ` +
              "Remove or reassign them first; nothing was changed.",
          );
        }

        const inPayments = Prisma.sql`"paymentId" IN (SELECT "id" FROM perf_payments)`;
        const inBookings = Prisma.sql`"bookingId" IN (SELECT "id" FROM perf_bookings)`;
        removed.payment_event = await deleteGuarded(tx, "payment_event", "payment_event_no_update_delete", inPayments);
        removed.chat_message = await deleteGuarded(tx, "chat_message", "chat_message_no_update_delete", inBookings);
        removed.refund = await tx.$executeRaw`DELETE FROM "refund" WHERE "idempotencyKey" LIKE ${keyLike} OR ${inPayments}`;
        removed.payment = await tx.$executeRaw`DELETE FROM "payment" WHERE "id" IN (SELECT "id" FROM perf_payments)`;
        removed.quote = await tx.$executeRaw`DELETE FROM "quote" WHERE ${inBookings}`;
        removed.reschedule_request = await tx.$executeRaw`DELETE FROM "reschedule_request" WHERE ${inBookings}`;
        removed.dispute = await tx.$executeRaw`DELETE FROM "dispute" WHERE ${inBookings}`; // dispute_message cascades
        removed.booking = await tx.$executeRaw`DELETE FROM "booking" WHERE "id" IN (SELECT "id" FROM perf_bookings)`; // booking_event cascades

        // ---- audit log ----
        const auditWhere = Prisma.sql`"metadata"->>'perfSeed' = ${PERF_MARKER}`;
        const auditRows = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "audit_log" WHERE ${auditWhere}`);
        removed.audit_log = 0;
        if (auditRows > 0 && !keepAudit) {
          // ALTER TABLE takes an exclusive lock: no audit row can be appended while we decide and delete.
          await tx.$executeRawUnsafe(`ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_append_only"`);
          const first = (await tx.$queryRaw<{ first: number }[]>`SELECT min("seq")::int AS first FROM "audit_log" WHERE ${auditWhere}`)[0]!.first;
          const laterReal = await count(tx, Prisma.sql`SELECT count(*) AS n FROM "audit_log" WHERE "seq" > ${first} AND ("metadata"->>'perfSeed') IS DISTINCT FROM ${PERF_MARKER}`);
          if (laterReal > 0 && !rechain) {
            throw new Refusal(
              `${laterReal} real audit entr${laterReal === 1 ? "y was" : "ies were"} written after the performance entries. Deleting them would break the hash chain. ` +
                "Re-run with --rechain (renumbers and re-hashes the later rows; test databases only) or --keep-audit. Nothing was changed.",
            );
          }
          removed.audit_log = await tx.$executeRaw`DELETE FROM "audit_log" WHERE ${auditWhere}`;
          if (laterReal > 0) {
            if (!Number.isInteger(first) || first < 1) throw new Error("unexpected audit seq");
            await tx.$executeRawUnsafe(`
              DO $$
              DECLARE
                r record;
                n integer := ${first - 1};
                prev text := COALESCE((SELECT "hash" FROM "audit_log" WHERE "seq" = ${first - 1}), repeat('0', 64));
                h text;
              BEGIN
                -- Ascending order: every new seq is <= the old one, and rows not yet visited all have larger seqs,
                -- so the unique index on seq is never violated.
                FOR r IN SELECT "id" FROM "audit_log" WHERE "seq" >= ${first} ORDER BY "seq" LOOP
                  n := n + 1;
                  UPDATE "audit_log" SET "seq" = n, "prevHash" = prev WHERE "id" = r."id";
                  SELECT audit_log_hash(a) INTO h FROM "audit_log" a WHERE a."id" = r."id";
                  UPDATE "audit_log" SET "hash" = h WHERE "id" = r."id";
                  prev := h;
                END LOOP;
              END;
              $$`);
            removed.audit_log_rechained = laterReal;
          }
          await tx.$executeRawUnsafe(`ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_append_only"`);
        }

        // Users last: profiles, worker services, availability, favorites, sessions and accounts cascade; audit rows
        // that name a performance user as actor are detached (the one update the audit guard allows).
        removed.user = await tx.$executeRaw`DELETE FROM "user" WHERE "id" IN (SELECT "id" FROM perf_users)`;

        if (dryRun) throw new Rollback();
      },
      { timeout: 10 * 60_000, maxWait: 30_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return;
      throw error;
    });

  for (const [table, n] of Object.entries(removed)) console.log(`  ${table.padEnd(20)} ${n}`);
  if (dryRun) {
    console.log("[dry run] Rolled back: nothing was changed.");
  } else {
    // Same check as Admin > Audit log > Verify (src/admin/audit/audit-query.service.ts), read-only.
    const [chain] = await prisma.$queryRaw<{ checked: number; bad: number | null }[]>`
      WITH chk AS (
        SELECT a."seq", a."hash", a."prevHash", audit_log_hash(a) AS expected,
               lag(a."hash") OVER (ORDER BY a."seq") AS prev_hash, lag(a."seq") OVER (ORDER BY a."seq") AS prev_seq
        FROM "audit_log" a
      )
      SELECT count(*)::int AS checked,
             min("seq") FILTER (WHERE "hash" <> expected OR "prevHash" <> COALESCE(prev_hash, repeat('0', 64)) OR "seq" <> COALESCE(prev_seq, 0) + 1)::int AS bad
      FROM chk`;
    console.log(`Audit chain: ${chain!.checked} rows, ${chain!.bad === null ? "valid" : `INVALID from seq ${chain!.bad}`}.`);
    const left = await prisma.user.count({ where: { email: { endsWith: `@${PERF_EMAIL_DOMAIN}` } } });
    console.log(left === 0 ? "No performance data left." : `${left} performance users are still present.`);
  }
} catch (error) {
  if (error instanceof Refusal) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await prisma.$disconnect();
}
