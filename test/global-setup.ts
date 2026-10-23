import "dotenv/config";
import { execSync } from "node:child_process";
import { testDatabaseUrl } from "./test-db.js";

/** Applies migrations and seeds reference data on the test database only. */
export default function setup() {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync("npx prisma db seed", { env, stdio: "pipe" });
}
