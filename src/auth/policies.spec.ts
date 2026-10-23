import { describe, expect, it } from "vitest";
import { canAdminister, canReviewWorker, isApprovedWorker, isOwner } from "./policies.js";

describe("policies", () => {
  it("only ADMIN can administer", () => {
    expect(canAdminister({ role: "ADMIN" })).toBe(true);
    expect(canAdminister({ role: "USER" })).toBe(false);
  });

  it("a worker is approved only when SUBMITTED and VERIFIED", () => {
    const statuses = ["NOT_SUBMITTED", "PENDING", "VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"] as const;
    for (const onboardingStatus of ["DRAFT", "SUBMITTED"] as const) {
      for (const verificationStatus of statuses) {
        const expected = onboardingStatus === "SUBMITTED" && verificationStatus === "VERIFIED";
        expect(isApprovedWorker({ onboardingStatus, verificationStatus })).toBe(expected);
      }
    }
  });

  it("ownership compares the authenticated user with the resource owner", () => {
    expect(isOwner({ userId: "a" }, "a")).toBe(true);
    expect(isOwner({ userId: "a" }, "b")).toBe(false);
  });

  it("admins may review others but not themselves; non-admins may not review", () => {
    expect(canReviewWorker({ role: "ADMIN", userId: "a" }, "b")).toBe(true);
    expect(canReviewWorker({ role: "ADMIN", userId: "a" }, "a")).toBe(false);
    expect(canReviewWorker({ role: "USER", userId: "a" }, "b")).toBe(false);
  });
});
