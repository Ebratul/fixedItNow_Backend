/**
 * Shared by scripts/seed-perf.ts and scripts/clean-perf.ts.
 *
 * Every row the performance seed writes carries one of these markers, so the clean script can find exactly
 * that data and nothing else:
 *   user                    email ends with "@perf-seed.fixeditnow.test" (the .test TLD is reserved, never deliverable)
 *   booking/payment/refund  idempotencyKey starts with "perf-seed:"
 *   audit_log               metadata->>'perfSeed' = 'perf-seed'
 * Everything else the seed writes (profiles, worker services, availability, quotes, booking events, disputes)
 * hangs off a marked user or booking and is removed with it.
 */
export const PERF_MARKER = "perf-seed";
export const PERF_EMAIL_DOMAIN = "perf-seed.fixeditnow.test";
export const PERF_KEY_PREFIX = `${PERF_MARKER}:`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "db"]);

export type Args = { flags: Set<string>; values: Map<string, string> };

export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (m) values.set(m[1]!, m[2]!);
    else if (arg.startsWith("--")) flags.add(arg.slice(2));
  }
  return { flags, values };
}

export function intArg(args: Args, name: string, fallback: number, min = 0, max = 100_000): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be a whole number between ${min} and ${max}.`);
    process.exit(1);
  }
  return n;
}

/**
 * Refuses to touch anything but a local database unless the operator says so explicitly. The performance data is
 * fake but lives in the ordinary realm: published fake professionals would show on the public site of whatever
 * database this runs against. `backend/.env` points at a remote database, so the default must be "no".
 */
export function guardDatabase(args: Args, verb: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && !args.flags.has("allow-production")) {
    console.error(`Refusing to ${verb} with NODE_ENV=production. Re-run with --allow-production if you really mean it.`);
    process.exit(1);
  }
  if (!LOCAL_HOSTS.has(host) && !args.flags.has("allow-remote")) {
    console.error(`Refusing to ${verb} on the non-local database host "${host}".`);
    console.error("Point DATABASE_URL at a local or disposable database, or re-run with --allow-remote if this host is meant for it.");
    process.exit(1);
  }
  return host;
}
