import { describe, expect, it } from "vitest";
import { formatDecimalBdt, parseDecimalToPoisha, toPoisha } from "./money.js";

describe("money", () => {
  it("formats whole taka as a provider decimal using integers only", () => {
    expect(formatDecimalBdt(500)).toBe("500.00");
    expect(formatDecimalBdt(1)).toBe("1.00");
    expect(formatDecimalBdt(999_999)).toBe("999999.00");
    expect(() => formatDecimalBdt(1.5)).toThrow();
    expect(() => formatDecimalBdt(-1)).toThrow();
    expect(toPoisha(1150)).toBe(115_000);
  });

  it("parses provider amounts exactly", () => {
    expect(parseDecimalToPoisha("500")).toBe(50_000);
    expect(parseDecimalToPoisha("500.00")).toBe(50_000);
    expect(parseDecimalToPoisha("500.0000")).toBe(50_000);
    expect(parseDecimalToPoisha("1150.50")).toBe(115_050);
    expect(parseDecimalToPoisha(" 10.5 ")).toBe(1_050);
    expect(parseDecimalToPoisha(500)).toBe(50_000);
    expect(parseDecimalToPoisha(0.1 + 0.2)).toBeNull(); // 0.30000000000000004 is not an amount
  });

  it("rejects anything that is not a plain decimal, so a surprise can never look like a match", () => {
    for (const bad of ["", "abc", "-5", "5e2", "1,000.00", "500.001", "500.", ".5", "0x10", "1".repeat(12), null, undefined, {}, [], NaN, Infinity]) {
      expect(parseDecimalToPoisha(bad), `${typeof bad}:${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("compares like for like: 500.00 equals 500 taka, 500.01 does not", () => {
    expect(parseDecimalToPoisha("500.00")).toBe(toPoisha(500));
    expect(parseDecimalToPoisha("500.01")).not.toBe(toPoisha(500));
  });
});
