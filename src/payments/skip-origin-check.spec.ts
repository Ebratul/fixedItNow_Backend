import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "generated") return [];
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : [];
  });
}

describe("CSRF origin check exemption", () => {
  it("is used by the payment-provider callback controller and nowhere else", () => {
    const users = sources(join(import.meta.dirname, "..")).filter((file) => /@SkipOriginCheck\(\)|SkipOriginCheck\(/.test(readFileSync(file, "utf8")) && !file.endsWith("decorators.ts"));
    expect(users.map((f) => f.split("/src/")[1])).toEqual(["payments/payment-callbacks.controller.ts"]);
  });

  it("is always combined with @Public() on that controller and decorates no authenticated route", () => {
    const text = readFileSync(join(import.meta.dirname, "payment-callbacks.controller.ts"), "utf8");
    expect(text).toMatch(/@Public\(\)\s*@SkipOriginCheck\(\)\s*@Controller\("payments"\)/);
    expect(text).not.toMatch(/CurrentAuth|RequireAdmin/);
  });
});
