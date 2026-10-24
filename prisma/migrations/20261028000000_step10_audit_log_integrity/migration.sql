-- Step 10: audit_log integrity. Additive (one function, one trigger); no table or column is altered.
--
-- Audit rows are evidence. They may be inserted, never edited or removed, even by
-- application bugs or a compromised application role. The single permitted change is
-- the one PostgreSQL itself performs when a user account is deleted (the foreign key
-- is ON DELETE SET NULL): the actor reference is detached and nothing else changes.
-- TRUNCATE is not intercepted (same as payment_event); restrict it with database roles
-- in production (see docs/RUNBOOK.md).
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
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
