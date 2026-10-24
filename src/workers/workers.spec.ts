import { describe, expect, it } from "vitest";
import { canPublish, ELIGIBLE_WORKER, isListable } from "./eligibility.js";
import { isValidSlug, newSlug, slugStem } from "./slug.js";
import { escapeLike, searchQuerySchema, searchTerms } from "./workers.schema.js";

const base = { onboardingStatus: "SUBMITTED", verificationStatus: "VERIFIED", publishedAt: new Date(), suspendedAt: null, slug: "a-b" };

describe("eligibility", () => {
  it("is listable only when every condition holds", () => {
    expect(isListable(base)).toBe(true);
    expect(isListable({ ...base, onboardingStatus: "DRAFT" })).toBe(false);
    for (const verificationStatus of ["NOT_SUBMITTED", "PENDING", "REJECTED", "RESUBMISSION_REQUIRED"]) {
      expect(isListable({ ...base, verificationStatus })).toBe(false);
    }
    expect(isListable({ ...base, publishedAt: null })).toBe(false);
    expect(isListable({ ...base, suspendedAt: new Date() })).toBe(false);
    expect(isListable({ ...base, slug: null })).toBe(false);
  });

  it("the Prisma filter encodes the same conditions", () => {
    expect(ELIGIBLE_WORKER).toEqual({
      onboardingStatus: "SUBMITTED",
      verificationStatus: "VERIFIED",
      publishedAt: { not: null },
      suspendedAt: null,
      slug: { not: null },
    });
  });

  it("publishing needs approval and no suspension", () => {
    expect(canPublish({ onboardingStatus: "SUBMITTED", verificationStatus: "VERIFIED", suspendedAt: null })).toBe(true);
    expect(canPublish({ onboardingStatus: "SUBMITTED", verificationStatus: "PENDING", suspendedAt: null })).toBe(false);
    expect(canPublish({ onboardingStatus: "SUBMITTED", verificationStatus: "VERIFIED", suspendedAt: new Date() })).toBe(false);
  });
});

describe("slugs", () => {
  it("builds ASCII stems and a random suffix", () => {
    expect(slugStem("  Rahim  Uddin! ")).toBe("rahim-uddin");
    expect(slugStem("José Ñandú")).toBe("jose-nandu");
    expect(slugStem("রহিম")).toBe("worker");
    expect(slugStem("x".repeat(200)).length).toBeLessThanOrEqual(40);
    expect(newSlug("Rahim")).toMatch(/^rahim-[0-9a-f]{8}$/);
    expect(newSlug("Rahim")).not.toBe(newSlug("Rahim"));
  });
  it("validates slug shape", () => {
    expect(isValidSlug("rahim-1a2b3c4d")).toBe(true);
    for (const bad of ["", "UPPER", "a_b", "a b", "-a", "a-", "a--b", "../etc", "x".repeat(61)]) expect(isValidSlug(bad)).toBe(false);
  });
});

describe("search query schema", () => {
  const parse = (input: Record<string, unknown>) => searchQuerySchema.safeParse(input);
  it("applies defaults", () => {
    expect(parse({})).toMatchObject({ success: true, data: { sort: "newest", page: 1, pageSize: 12 } });
  });
  it("treats blank values as absent", () => {
    const result = parse({ q: "   ", category: "", location: "", maxPrice: "" });
    expect(result.success && result.data.q).toBeUndefined();
    expect(result.success && result.data.maxPrice).toBeUndefined();
  });
  it("coerces numeric strings and enforces bounds", () => {
    expect(parse({ maxPrice: "500", minExperience: "3", page: "2", pageSize: "48" })).toMatchObject({ success: true, data: { maxPrice: 500, minExperience: 3, page: 2, pageSize: 48 } });
    for (const bad of [{ maxPrice: "49" }, { maxPrice: "1000001" }, { minExperience: "61" }, { page: "0" }, { pageSize: "49" }, { sort: "id; DROP" }, { location: "Narnia" }]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("drops unknown keys", () => {
    const result = parse({ userId: "1", verificationStatus: "PENDING" });
    expect(result.success && Object.keys(result.data).sort()).toEqual(["page", "pageSize", "sort"]);
  });
});

describe("search terms", () => {
  it("lowercases, splits, and caps the number of terms", () => {
    expect(searchTerms("  Rahim   WIRING ")).toEqual(["rahim", "wiring"]);
    expect(searchTerms("a b c d e f g")).toHaveLength(5);
    expect(searchTerms(undefined)).toEqual([]);
  });
  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("50%_\\")).toBe("50\\%\\_\\\\");
    expect(searchTerms("100%")).toEqual(["100\\%"]);
  });
});
