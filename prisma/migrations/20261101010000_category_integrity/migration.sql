-- Category hierarchy integrity (additive; no table or column changes).
--
-- Rules enforced for ANY writer, not just the admin API:
--   * a subcategory cannot be active while its parent is inactive
--   * a parent cannot be deactivated while it still has active subcategories
-- (The one-level-deep rule already lives in service_category_depth_guard from the admin panel migration.)
CREATE FUNCTION service_category_active_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."parentId" IS NOT NULL AND NEW."isActive" THEN
    IF EXISTS (SELECT 1 FROM "service_category" WHERE "id" = NEW."parentId" AND NOT "isActive") THEN
      RAISE EXCEPTION 'an active subcategory needs an active parent category';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."isActive" AND NOT NEW."isActive" THEN
    IF EXISTS (SELECT 1 FROM "service_category" WHERE "parentId" = NEW."id" AND "isActive") THEN
      RAISE EXCEPTION 'deactivate the subcategories of this category first';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER service_category_active
  BEFORE INSERT OR UPDATE OF "isActive", "parentId" ON "service_category"
  FOR EACH ROW EXECUTE FUNCTION service_category_active_guard();
