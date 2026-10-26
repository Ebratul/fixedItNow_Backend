import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../admin/permissions.js";
import { DEMO_ADMIN_PERMISSIONS, DEMO_KEYS, DEMO_PROFILES, demoKeyOf, demoRoleOf, isDemoEmail, isDemoKey } from "./demo.config.js";

describe("demo configuration", () => {
  it("the demo administrator's allow-list is read-only and inside the catalogue", () => {
    for (const p of DEMO_ADMIN_PERMISSIONS) {
      expect(ALL_PERMISSIONS).toContain(p);
      expect(p, p).not.toMatch(/\.(manage|review|decide|process|suspend|assign|reconcile|verify)$/);
    }
    for (const forbidden of ["roles.read", "roles.manage", "admins.assign", "ops.read", "audit.read", "settings.manage", "workers.documents.view", "refunds.process", "catalog.manage"]) {
      expect(DEMO_ADMIN_PERMISSIONS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("maps keys to roles one to one and only accepts the three names", () => {
    expect(DEMO_KEYS.map((k) => demoRoleOf(k))).toEqual(["CUSTOMER", "WORKER", "ADMIN"]);
    expect(DEMO_KEYS.map((k) => demoKeyOf(demoRoleOf(k)))).toEqual([...DEMO_KEYS]);
    for (const bad of ["ADMIN", "super_admin", "", undefined, null, 1, ["admin"]]) expect(isDemoKey(bad)).toBe(false);
  });

  it("uses only reserved, undeliverable addresses", () => {
    for (const k of DEMO_KEYS) {
      expect(DEMO_PROFILES[k].email).toMatch(/\.invalid$/);
      expect(isDemoEmail(DEMO_PROFILES[k].email)).toBe(true);
    }
    expect(isDemoEmail("someone@example.com")).toBe(false);
    expect(isDemoEmail("Demo.Admin@DEMO.FIXEDITNOW.INVALID")).toBe(true);
  });
});
