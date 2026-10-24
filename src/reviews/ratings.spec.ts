import { describe, expect, it } from "vitest";
import { roundRating } from "./ratings.js";

describe("roundRating", () => {
  it("rounds to one decimal, halves up", () => {
    expect(roundRating(4.25)).toBe(4.3);
    expect(roundRating(4.333333)).toBe(4.3);
    expect(roundRating(4.35)).toBe(4.4);
    expect(roundRating(5)).toBe(5);
    expect(roundRating(1)).toBe(1);
    expect(roundRating(3.049)).toBe(3);
  });
});
