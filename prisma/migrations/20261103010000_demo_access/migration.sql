-- Demo access (docs/DEMO.md), part 2 of 2. Additive and reversible: it adds two columns and constraints to "user",
-- one system admin role, and three guard triggers. It changes no existing row, and creates no demo user (the
-- operator command `npm run demo:seed` does that).
--
-- The demo REALM: every demo account has "isDemo" = true and the application filters every query on that column
-- (src/prisma/realm.ts), so demo sessions only ever see demo rows and ordinary sessions never see them. The
-- triggers below are a second, independent barrier at the one place where mixing the two would be dangerous
-- (money, bookings, admin power), so a bug or a script cannot cross the line either.

-- CreateEnum
CREATE TYPE "DemoRole" AS ENUM ('CUSTOMER', 'WORKER', 'ADMIN');

-- AlterTable
ALTER TABLE "user" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "demoRole" "DemoRole";

-- CreateIndex
CREATE UNIQUE INDEX "user_demoRole_key" ON "user"("demoRole");

-- CreateIndex
CREATE INDEX "user_isDemo_idx" ON "user"("isDemo");

-- A login identity is always a demo account. An ADMIN in the demo realm can only be the demo administrator.
ALTER TABLE "user" ADD CONSTRAINT "user_demo_role_implies_demo" CHECK ("demoRole" IS NULL OR "isDemo");
ALTER TABLE "user" ADD CONSTRAINT "user_demo_admin_only_demo_admin" CHECK (NOT ("isDemo" AND "role" = 'ADMIN') OR "demoRole" = 'ADMIN');
ALTER TABLE "user" ADD CONSTRAINT "user_demo_role_matches_role" CHECK ("demoRole" IS DISTINCT FROM 'ADMIN' OR "role" = 'ADMIN');

-- ---------------------------------------------------------------------------
-- The demo administrator's role. System role: immutable (see admin_role_system_guard), so an administrator cannot
-- widen it from the admin panel. The application ALSO intersects it with an allow-list in code
-- (src/demo/demo.config.ts), so even a database edit cannot give the demo administrator a write permission.
-- ---------------------------------------------------------------------------
INSERT INTO "admin_role" ("id", "key", "name", "description", "permissions", "isSystem", "updatedAt")
VALUES (gen_random_uuid()::text, 'demo_admin', 'Demo administrator',
        'Read-only access for the public demo. Reads only fictional demo data; every change is refused. Cannot be assigned to ordinary accounts.',
        ARRAY['dashboard.view', 'users.read', 'workers.read', 'bookings.read', 'disputes.read', 'payments.read', 'finance.reports', 'support.read', 'moderation.read', 'settings.read'],
        true, CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- user: the realm is permanent, and the demo role never reaches an ordinary account (or the reverse).
-- ---------------------------------------------------------------------------
CREATE FUNCTION user_demo_guard() RETURNS trigger AS $$
DECLARE
  role_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."isDemo" IS DISTINCT FROM OLD."isDemo" OR NEW."demoRole" IS DISTINCT FROM OLD."demoRole") THEN
    RAISE EXCEPTION 'a user cannot enter or leave the demo realm' USING ERRCODE = '23514';
  END IF;
  IF NEW."adminRoleId" IS NOT NULL THEN
    SELECT "key" INTO role_key FROM "admin_role" WHERE "id" = NEW."adminRoleId";
  END IF;
  IF NEW."isDemo" THEN
    IF NEW."role" = 'ADMIN' AND role_key IS DISTINCT FROM 'demo_admin' THEN
      RAISE EXCEPTION 'a demo administrator can only hold the demo_admin role' USING ERRCODE = '23514';
    END IF;
  ELSIF role_key = 'demo_admin' THEN
    RAISE EXCEPTION 'the demo_admin role can only be held by the demo administrator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_demo_realm
  BEFORE INSERT OR UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION user_demo_guard();

-- ---------------------------------------------------------------------------
-- booking: both sides are in the same realm (a demo customer can never book a real professional, nor the reverse).
-- ---------------------------------------------------------------------------
CREATE FUNCTION booking_realm_guard() RETURNS trigger AS $$
DECLARE
  customer_demo boolean;
  worker_demo boolean;
BEGIN
  SELECT u."isDemo" INTO customer_demo FROM "user" u WHERE u."id" = NEW."customerId";
  SELECT u."isDemo" INTO worker_demo FROM "worker_profile" wp JOIN "user" u ON u."id" = wp."userId" WHERE wp."id" = NEW."workerProfileId";
  IF customer_demo IS DISTINCT FROM worker_demo THEN
    RAISE EXCEPTION 'a booking cannot connect a demo account with an ordinary one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER booking_realm
  BEFORE INSERT OR UPDATE OF "customerId", "workerProfileId" ON "booking"
  FOR EACH ROW EXECUTE FUNCTION booking_realm_guard();

-- ---------------------------------------------------------------------------
-- payment: the simulated provider belongs to demo customers and ONLY to them. A demo customer can never have a
-- payment with a real provider, and no ordinary customer can have a simulated one. Simulated payments are never "live".
-- ---------------------------------------------------------------------------
CREATE FUNCTION payment_realm_guard() RETURNS trigger AS $$
DECLARE
  customer_demo boolean;
BEGIN
  SELECT u."isDemo" INTO customer_demo FROM "user" u WHERE u."id" = NEW."customerId";
  IF (NEW."provider"::text = 'DEMO') IS DISTINCT FROM customer_demo THEN
    RAISE EXCEPTION 'simulated payments are for demo accounts only, and demo accounts only use simulated payments' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payment_realm
  BEFORE INSERT OR UPDATE OF "customerId", "provider" ON "payment"
  FOR EACH ROW EXECUTE FUNCTION payment_realm_guard();

ALTER TABLE "payment" ADD CONSTRAINT "payment_demo_never_live" CHECK ("provider"::text <> 'DEMO' OR NOT "isLive");
