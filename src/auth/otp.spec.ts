import { describe, expect, it } from "vitest";
import {
  OTP_LENGTH,
  OTP_MAX_SENDS_PER_HOUR,
  OTP_RESEND_COOLDOWN_SECONDS,
  formatSendState,
  generateOtp,
  makeOtpHasher,
  mayResend,
  nextSendState,
  parseSendState,
  throttleIdentifier,
} from "./otp.js";

describe("generateOtp", () => {
  it("is always exactly six decimal digits, including leading zeros", () => {
    for (let i = 0; i < 2000; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
    expect(OTP_LENGTH).toBe(6);
  });

  it("is not constant and covers the digit space evenly (sanity check, not a proof of randomness)", () => {
    const counts = Array.from({ length: 10 }, () => 0);
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const code = generateOtp();
      seen.add(code);
      for (const ch of code) counts[Number(ch)]!++;
    }
    expect(seen.size).toBeGreaterThan(19_000); // 20k draws from 1M: collisions are rare
    const expected = (20_000 * OTP_LENGTH) / 10;
    for (const c of counts) expect(Math.abs(c - expected) / expected).toBeLessThan(0.05);
  });
});

describe("makeOtpHasher", () => {
  it("stores a keyed hash: deterministic per secret, different per secret, never the code itself", async () => {
    const a = makeOtpHasher("secret-one-secret-one-secret-one-xx");
    const b = makeOtpHasher("secret-two-secret-two-secret-two-xx");
    expect(await a("123456")).toBe(await a("123456"));
    expect(await a("123456")).not.toBe(await a("123457"));
    expect(await a("123456")).not.toBe(await b("123456")); // a copied database alone cannot be brute-forced offline
    expect(await a("123456")).toMatch(/^[0-9a-f]{64}$/);
    expect(await a("123456")).not.toContain("123456");
  });
});

describe("per-address send throttle", () => {
  const T0 = 1_000_000_000_000;
  it("hashes the address and normalises case", () => {
    expect(throttleIdentifier("A@Example.com ")).toBe(throttleIdentifier("a@example.com"));
    expect(throttleIdentifier("a@example.com")).not.toContain("example");
  });
  it("allows the first send, then enforces the cooldown and the hourly cap", () => {
    expect(mayResend(null, T0)).toBe(true);
    let state = nextSendState(null, T0);
    expect(mayResend(state, T0 + 1000)).toBe(false);
    expect(mayResend(state, T0 + OTP_RESEND_COOLDOWN_SECONDS * 1000 - 1)).toBe(false);
    expect(mayResend(state, T0 + OTP_RESEND_COOLDOWN_SECONDS * 1000)).toBe(true);
    for (let i = 1; i < OTP_MAX_SENDS_PER_HOUR; i++) state = nextSendState(state, T0 + i * 61_000);
    expect(state.count).toBe(OTP_MAX_SENDS_PER_HOUR);
    expect(mayResend(state, state.lastSentMs + 120_000)).toBe(false);
  });
  it("round-trips and rejects malformed state", () => {
    expect(parseSendState(formatSendState({ count: 3, lastSentMs: T0 }))).toEqual({ count: 3, lastSentMs: T0 });
    for (const bad of [undefined, "", "x", "1", "a:b", "1.5:2"]) expect(parseSendState(bad)).toBeNull();
  });
});
