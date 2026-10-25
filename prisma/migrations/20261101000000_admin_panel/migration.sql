-- Admin panel migration.
--
-- Everything below the generated DDL is hand-written because Prisma cannot model it:
--   * CHECK constraints and small guard triggers (data integrity beyond what the API validates)
--   * the audit_log hash chain (tamper evidence) and the updated append-only guard
--   * the system role `super_admin` and the backfill of existing administrators
-- The generated part was produced with `prisma migrate diff` and is reproducible.

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('NID_FRONT', 'NID_BACK', 'SELFIE_WITH_ID');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('GENERAL', 'BOOKING', 'PAYMENT', 'ACCOUNT', 'WORKER_COMPLAINT', 'CUSTOMER_COMPLAINT', 'SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'CUSTOMERS', 'WORKERS');

-- CreateEnum
CREATE TYPE "AnnouncementSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "actorSnapshot" TEXT,
ADD COLUMN     "hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "prevHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "service_category" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "adminRoleId" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT;

-- CreateTable
CREATE TABLE "admin_role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_document" (
    "id" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "requesterId" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "bookingId" TEXT,
    "assigneeId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_message" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "ActorRole" NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'INFO',
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "knowledge_document" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_revision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_key_key" ON "admin_role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "worker_document_workerProfileId_kind_key" ON "worker_document"("workerProfileId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_number_key" ON "support_ticket"("number");

-- CreateIndex
CREATE INDEX "support_ticket_status_priority_lastMessageAt_idx" ON "support_ticket"("status", "priority", "lastMessageAt");

-- CreateIndex
CREATE INDEX "support_ticket_requesterId_createdAt_idx" ON "support_ticket"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "support_ticket_assigneeId_status_idx" ON "support_ticket"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "support_ticket_message_ticketId_createdAt_idx" ON "support_ticket_message"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "announcement_status_audience_startsAt_idx" ON "announcement"("status", "audience", "startsAt");

-- CreateIndex
CREATE INDEX "notification_userId_readAt_createdAt_idx" ON "notification"("userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_slug_key" ON "knowledge_document"("slug");

-- CreateIndex
CREATE INDEX "knowledge_document_status_idx" ON "knowledge_document"("status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_revision_documentId_version_key" ON "knowledge_revision"("documentId", "version");

-- CreateIndex
CREATE INDEX "audit_log_action_createdAt_idx" ON "audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "service_category_parentId_idx" ON "service_category"("parentId");

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE INDEX "user_createdAt_idx" ON "user"("createdAt");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_adminRoleId_fkey" FOREIGN KEY ("adminRoleId") REFERENCES "admin_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "service_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_document" ADD CONSTRAINT "worker_document_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_message" ADD CONSTRAINT "support_ticket_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_message" ADD CONSTRAINT "support_ticket_message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_revision" ADD CONSTRAINT "knowledge_revision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Integrity constraints
-- ===========================================================================

-- A role can only be attached to an administrator; an admin with no role has no permissions.
ALTER TABLE "user" ADD CONSTRAINT "user_admin_role_requires_admin"
  CHECK ("adminRoleId" IS NULL OR "role" = 'ADMIN');
ALTER TABLE "user" ADD CONSTRAINT "user_suspension_has_reason"
  CHECK ("suspendedAt" IS NULL OR "suspensionReason" IS NOT NULL);

ALTER TABLE "admin_role" ADD CONSTRAINT "admin_role_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,40}$');
ALTER TABLE "admin_role" ADD CONSTRAINT "admin_role_permissions_not_empty" CHECK (cardinality("permissions") BETWEEN 1 AND 100);

ALTER TABLE "service_category" ADD CONSTRAINT "service_category_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");

ALTER TABLE "worker_document" ADD CONSTRAINT "worker_document_size" CHECK ("sizeBytes" BETWEEN 1 AND 5242880);
ALTER TABLE "worker_document" ADD CONSTRAINT "worker_document_mime" CHECK ("mimeType" IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE "worker_document" ADD CONSTRAINT "worker_document_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "worker_document" ADD CONSTRAINT "worker_document_iv_length" CHECK (octet_length("iv") = 12 AND octet_length("authTag") = 16);

ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_subject_length" CHECK (char_length("subject") BETWEEN 3 AND 140);
ALTER TABLE "support_ticket_message" ADD CONSTRAINT "support_ticket_message_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000);

ALTER TABLE "announcement" ADD CONSTRAINT "announcement_title_length" CHECK (char_length("title") BETWEEN 3 AND 120);
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_window" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_published_has_time" CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

-- In-app paths only: never an absolute or protocol-relative URL (no open redirects from a notification).
ALTER TABLE "notification" ADD CONSTRAINT "notification_link_is_local_path" CHECK ("link" IS NULL OR "link" ~ '^/([A-Za-z0-9._~!$&''()*+,;=:@%/?#-]*)$' AND "link" !~ '^//');
ALTER TABLE "notification" ADD CONSTRAINT "notification_text_length" CHECK (char_length("title") BETWEEN 1 AND 120 AND char_length("body") BETWEEN 1 AND 1000);

ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,59}$');
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_url_format" CHECK ("url" ~ '^/[a-z0-9/-]*$');
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_version_positive" CHECK ("version" >= 1);
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_published_has_time" CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

-- Subcategories are one level deep.
CREATE FUNCTION service_category_depth_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."parentId" IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "service_category" WHERE "id" = NEW."parentId" AND "parentId" IS NOT NULL) THEN
      RAISE EXCEPTION 'a subcategory cannot have subcategories';
    END IF;
    IF EXISTS (SELECT 1 FROM "service_category" WHERE "parentId" = NEW."id") THEN
      RAISE EXCEPTION 'a category that has subcategories cannot become a subcategory';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER service_category_depth
  BEFORE INSERT OR UPDATE OF "parentId" ON "service_category"
  FOR EACH ROW EXECUTE FUNCTION service_category_depth_guard();

-- ===========================================================================
-- Admin roles
-- ===========================================================================

INSERT INTO "admin_role" ("id", "key", "name", "description", "permissions", "isSystem", "updatedAt")
VALUES (gen_random_uuid()::text, 'super_admin', 'Super administrator',
        'Every permission, including ones added in future releases. Cannot be edited or deleted.',
        ARRAY['*'], true, CURRENT_TIMESTAMP);

-- Administrators that existed before roles keep working: they become super administrators.
UPDATE "user" SET "adminRoleId" = (SELECT "id" FROM "admin_role" WHERE "key" = 'super_admin') WHERE "role" = 'ADMIN';

-- System roles are immutable, whatever the application does.
CREATE FUNCTION admin_role_system_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."isSystem" THEN
    RAISE EXCEPTION 'system admin roles cannot be changed or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admin_role_system_immutable
  BEFORE UPDATE OR DELETE ON "admin_role"
  FOR EACH ROW EXECUTE FUNCTION admin_role_system_guard();

-- Lock-out protection: the last active super administrator cannot be demoted, un-roled or
-- suspended. Concurrent attempts are serialised with an advisory lock so two simultaneous
-- demotions cannot both succeed. (Deleting a user row is an operator action and is not blocked.)
CREATE FUNCTION user_keep_super_admin() RETURNS trigger AS $$
DECLARE
  super_id text;
BEGIN
  SELECT "id" INTO super_id FROM "admin_role" WHERE "key" = 'super_admin';
  IF super_id IS NOT NULL
     AND OLD."role" = 'ADMIN' AND OLD."adminRoleId" = super_id AND OLD."suspendedAt" IS NULL
     AND NOT (NEW."role" = 'ADMIN' AND NEW."adminRoleId" = super_id AND NEW."suspendedAt" IS NULL) THEN
    PERFORM pg_advisory_xact_lock(7402981124);
    IF NOT EXISTS (
      SELECT 1 FROM "user"
      WHERE "id" <> OLD."id" AND "role" = 'ADMIN' AND "adminRoleId" = super_id AND "suspendedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'the last active super administrator cannot be removed or suspended';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_keep_super_admin
  BEFORE UPDATE OF "role", "adminRoleId", "suspendedAt" ON "user"
  FOR EACH ROW EXECUTE FUNCTION user_keep_super_admin();

-- ===========================================================================
-- Audit log: hash chain (tamper evidence) on top of the append-only guard
-- ===========================================================================
--
-- Every row stores seq (gap-free), prevHash (hash of the previous row) and hash =
-- sha256(canonical JSON of the row's content + prevHash). Editing or deleting any row, or
-- inserting one into the middle, breaks the chain and is found by audit_log_verify().
-- Rows are written by a trigger under an advisory lock, so callers need no changes.
-- Limits: someone with superuser access can disable triggers and rebuild the whole chain;
-- anchor the head hash outside the database (docs/ADMIN.md) to detect that.

CREATE FUNCTION audit_log_hash(r "audit_log") RETURNS text AS $$
  SELECT encode(
    sha256(convert_to(
      jsonb_build_array(
        r."seq", r."id", r."actorSnapshot", r."action", r."targetType", r."targetId", r."metadata",
        to_char(r."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), r."prevHash"
      )::text, 'UTF8')),
    'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Backfill existing rows in time order. The append-only guard is dropped only for this statement block.
DROP TRIGGER "audit_log_append_only" ON "audit_log";
DO $$
DECLARE
  r record;
  n integer := 0;
  prev text := repeat('0', 64);
  h text;
BEGIN
  FOR r IN SELECT "id" FROM "audit_log" ORDER BY "createdAt", "id" LOOP
    n := n + 1;
    UPDATE "audit_log" SET "seq" = n, "prevHash" = prev, "actorSnapshot" = "actorId" WHERE "id" = r."id";
    SELECT audit_log_hash(a) INTO h FROM "audit_log" a WHERE a."id" = r."id";
    UPDATE "audit_log" SET "hash" = h WHERE "id" = r."id";
    prev := h;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit_log"("seq");

CREATE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  last_seq integer;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(7402981123);
  SELECT "seq", "hash" INTO last_seq, last_hash FROM "audit_log" ORDER BY "seq" DESC LIMIT 1;
  NEW."seq" := COALESCE(last_seq, 0) + 1;
  NEW."prevHash" := COALESCE(last_hash, repeat('0', 64));
  NEW."actorSnapshot" := NEW."actorId";
  NEW."hash" := audit_log_hash(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_chain_insert
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Same rule as before (the only permitted UPDATE is the ON DELETE SET NULL actor detach),
-- now also covering the chain columns.
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL
     AND NEW."actorId" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."action" = OLD."action"
     AND NEW."targetType" = OLD."targetType"
     AND NEW."targetId" = OLD."targetId"
     AND NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."seq" = OLD."seq"
     AND NEW."prevHash" = OLD."prevHash"
     AND NEW."hash" = OLD."hash"
     AND NEW."actorSnapshot" IS NOT DISTINCT FROM OLD."actorSnapshot" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
