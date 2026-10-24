import { describe, expect, it } from "vitest";
import { aiResponseSchema, chatRequestSchema } from "./ai.schemas.js";

const valid = {
  kind: "results",
  message: "ok",
  language: "en",
  intent: {},
  intentSources: {},
  clarification: null,
  recommendations: [],
  total: 0,
  relaxations: [],
  answer: null,
  notes: [],
  mode: "simple",
};

describe("chat request schema", () => {
  it("trims, defaults the locale, and rejects unknown keys", () => {
    expect(chatRequestSchema.parse({ message: "  hi  " })).toEqual({ message: "hi", locale: "auto", action: "message" });
    expect(chatRequestSchema.safeParse({ message: "hi", userId: "x" }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: "   " }).success).toBe(false);
  });
});

describe("AI response schema", () => {
  it("accepts a well-formed response and nothing extra", () => {
    expect(aiResponseSchema.safeParse(valid).success).toBe(true);
    expect(aiResponseSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("only allows references (id/slug/rank/matchedOn) for workers, with a uuid-like id", () => {
    const rec = { workerId: "0198a2c4-1b2c-7d3e-8f40-123456789abc", slug: "s", rank: 1, matchedOn: ["CATEGORY"] };
    expect(aiResponseSchema.safeParse({ ...valid, recommendations: [rec] }).success).toBe(true);
    expect(aiResponseSchema.safeParse({ ...valid, recommendations: [{ ...rec, displayName: "x" }] }).success).toBe(false);
    expect(aiResponseSchema.safeParse({ ...valid, recommendations: [{ ...rec, workerId: "1 OR 1=1" }] }).success).toBe(false);
  });

  it("only allows site-relative source links", () => {
    const answer = (url: string) => ({ ...valid, kind: "answer", answer: { text: "t", grounded: true, sources: [{ id: "a", title: "t", url }] } });
    expect(aiResponseSchema.safeParse(answer("/bookings")).success).toBe(true);
    for (const url of ["https://x.example", "//x.example", "javascript:alert(1)", "/A"]) {
      expect(aiResponseSchema.safeParse(answer(url)).success).toBe(false);
    }
  });
});
