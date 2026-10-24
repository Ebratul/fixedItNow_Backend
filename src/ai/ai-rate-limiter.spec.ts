import { describe, expect, it } from "vitest";
import { AiRateLimiter } from "./ai-rate-limiter.js";

describe("AiRateLimiter", () => {
  it("allows up to the limit per window and reports the wait", () => {
    const limiter = new AiRateLimiter();
    expect([0, 0].map((i) => limiter.check("u", 2, 1000 + i))).toEqual([0, 0]);
    expect(limiter.check("u", 2, 1000 + 20_000)).toBe(40);
    expect(limiter.check("u", 2, 1000 + 60_001)).toBe(0);
  });

  it("keeps users apart and does not count rejected attempts", () => {
    const limiter = new AiRateLimiter();
    limiter.check("a", 1, 0);
    expect(limiter.check("a", 1, 1)).toBeGreaterThan(0);
    expect(limiter.check("a", 1, 2)).toBeGreaterThan(0);
    expect(limiter.check("b", 1, 3)).toBe(0);
    expect(limiter.check("a", 1, 60_000)).toBe(0); // only the first (accepted) hit counted
  });
});
