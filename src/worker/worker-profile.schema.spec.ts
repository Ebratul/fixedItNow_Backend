import { describe, expect, it } from "vitest";
import { workerDraftSchema, workerSubmitSchema } from "./worker-profile.schema.js";

describe("workerDraftSchema", () => {
  it("accepts partial drafts", () => {
    expect(workerDraftSchema.safeParse({ displayName: "Rahim" }).success).toBe(true);
    expect(workerDraftSchema.safeParse({}).success).toBe(true);
  });

  it("rejects fields a worker must never control", () => {
    for (const key of ["verificationStatus", "onboardingStatus", "userId", "id", "role", "reviewedById"]) {
      expect(workerDraftSchema.safeParse({ [key]: "x" }).success, key).toBe(false);
    }
  });

  it("trims whitespace", () => {
    const parsed = workerDraftSchema.parse({ displayName: "  Rahim  " });
    expect(parsed.displayName).toBe("Rahim");
  });
});

describe("workerSubmitSchema", () => {
  const complete = {
    displayName: "Rahim",
    bio: "x".repeat(30),
    experienceYears: 3,
    languages: ["Bangla"],
    serviceAreas: ["Dhaka"],
    services: [{ categorySlug: "plumbing", pricingModel: "QUOTE" }],
  };
  it("accepts a complete profile", () => {
    expect(workerSubmitSchema.safeParse(complete).success).toBe(true);
  });
  it.each(["displayName", "bio", "experienceYears", "languages", "serviceAreas", "services"])("requires %s", (key) => {
    expect(workerSubmitSchema.safeParse({ ...complete, [key]: undefined }).success).toBe(false);
  });
  it("requires a meaningful bio", () => {
    expect(workerSubmitSchema.safeParse({ ...complete, bio: "too short" }).success).toBe(false);
  });
});
