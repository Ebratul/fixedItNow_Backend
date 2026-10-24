import { describe, expect, it } from "vitest";
import { excerpt, nullableUserText, optionalUserText, publicName, userText } from "./user-text.js";

describe("userText", () => {
  const text = userText(3, 10, "Title");
  it("trims, normalises line endings and enforces length", () => {
    expect(userText(3, 20).parse("  hello\r\nworld ")).toBe("hello\nworld");
    expect(text.safeParse("ab").success).toBe(false);
    expect(text.safeParse("x".repeat(11)).success).toBe(false);
    expect(text.safeParse("   ").success).toBe(false);
  });
  it("rejects control and bidi-override characters but keeps markup, emoji and Bangla as plain text", () => {
    for (const bad of ["a\u0000b!", "a\u0007bc", "ab‮c", "abc⁦d", "ab﻿c"]) expect(text.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(text.parse("<b>x</b>")).toBe("<b>x</b>");
    expect(userText(1, 20).parse("ভালো কাজ 👍")).toBe("ভালো কাজ 👍");
    expect(userText(1, 20).parse("tab\tok")).toBe("tab\tok");
  });
  it("optional text: blank means absent; nullable text: blank or null means clear", () => {
    expect(optionalUserText(5).parse("   ")).toBeUndefined();
    expect(optionalUserText(5).parse(undefined)).toBeUndefined();
    expect(optionalUserText(5).safeParse("toolong").success).toBe(false);
    expect(nullableUserText(5).parse("  ")).toBeNull();
    expect(nullableUserText(5).parse(null)).toBeNull();
    expect(nullableUserText(5).parse(undefined)).toBeUndefined();
    expect(nullableUserText(5).parse(" ok ")).toBe("ok");
  });
});

describe("publicName", () => {
  it("prefers the chosen display name, else the first word of the account name, never an email", () => {
    expect(publicName({ name: "Asha Rahman", customerProfile: { displayName: "Asha R." } })).toBe("Asha R.");
    expect(publicName({ name: "Asha Rahman", customerProfile: null })).toBe("Asha");
    expect(publicName({ name: "  ", customerProfile: null })).toBe("Member");
    expect(publicName({ name: "আশা রহমান" })).toBe("আশা");
  });
});

describe("excerpt", () => {
  it("cuts long text without splitting a surrogate pair", () => {
    expect(excerpt("short", 10)).toEqual({ text: "short", truncated: false });
    const cut = excerpt("ab👍👍👍", 3);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe("ab…");
  });
});
