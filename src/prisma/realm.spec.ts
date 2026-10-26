import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma/client.js";
import { SCOPES, SHARED } from "./realm.js";

describe("realm firewall classification", () => {
  it("classifies EVERY model: a table added later cannot silently skip the firewall", () => {
    expect(Object.keys(SCOPES).sort()).toEqual(Object.values(Prisma.ModelName).sort());
  });

  it("shares only reference data, never anything a person owns", () => {
    const shared = Object.entries(SCOPES).filter(([, s]) => s === SHARED).map(([m]) => m).sort();
    expect(shared).toEqual(["AdminRole", "Announcement", "KnowledgeDocument", "KnowledgeRevision", "PlatformSetting", "RateLimit", "ServiceCategory", "Verification"]);
  });

  it("builds a filter on the demo flag of the owning user, through the right relation path", () => {
    const scope = (model: keyof typeof SCOPES, demo: boolean) => (SCOPES[model] as (d: boolean) => unknown)(demo);
    expect(scope("User", true)).toEqual({ isDemo: true });
    expect(scope("Booking", false)).toEqual({ customer: { isDemo: false } });
    expect(scope("DisputeMessage", true)).toEqual({ dispute: { booking: { customer: { isDemo: true } } } });
    expect(scope("WorkerService", false)).toEqual({ workerProfile: { user: { isDemo: false } } });
    // operator-script audit rows (no actor) belong to the real realm only
    expect(scope("AuditLog", false)).toEqual({ OR: [{ actorId: null }, { actor: { isDemo: false } }] });
    expect(scope("AuditLog", true)).toEqual({ actor: { isDemo: true } });
  });
});
