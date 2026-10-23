import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  FRONTEND_ORIGIN: "http://localhost:3000",
};
const prod = {
  ...base,
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://app.example.com",
  FRONTEND_ORIGIN: "https://app.example.com",
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  TRUSTED_PROXIES: "10.0.0.0/24",
};

describe("loadEnv", () => {
  it("accepts a minimal development configuration and defaults to console mail", () => {
    const env = loadEnv(base);
    expect(env.MAIL_TRANSPORT).toBe("console");
    expect(env.googleEnabled).toBe(false);
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });

  it("requires a long secret", () => {
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET: undefined })).toThrow();
  });

  it("requires Google credentials to be set together", () => {
    expect(() => loadEnv({ ...base, GOOGLE_CLIENT_ID: "id" })).toThrow(/GOOGLE_CLIENT_ID/);
    const env = loadEnv({ ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
    expect(env.googleEnabled).toBe(true);
  });

  it("treats blank optional values as unset", () => {
    expect(loadEnv({ ...base, GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "" }).googleEnabled).toBe(false);
  });

  it("accepts a valid production configuration", () => {
    const env = loadEnv(prod);
    expect(env.MAIL_TRANSPORT).toBe("smtp");
  });

  it("refuses insecure production settings", () => {
    expect(() => loadEnv({ ...prod, BETTER_AUTH_URL: "http://app.example.com" })).toThrow(/https/);
    expect(() => loadEnv({ ...prod, MAIL_TRANSPORT: "console" })).toThrow(/console/);
    expect(() => loadEnv({ ...prod, SMTP_HOST: undefined })).toThrow(/SMTP_HOST/);
    expect(() => loadEnv({ ...prod, RATE_LIMIT_ENABLED: "false" })).toThrow(/Rate limiting/);
    expect(() => loadEnv({ ...prod, TRUSTED_PROXIES: undefined })).toThrow(/TRUSTED_PROXIES/);
  });

  it("does not include secret values in its error message", () => {
    try {
      loadEnv({ ...base, BETTER_AUTH_SECRET: "short-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("short-secret-value");
    }
  });
});
