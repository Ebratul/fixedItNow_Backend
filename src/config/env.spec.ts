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

  describe("payment providers", () => {
    const bkash = {
      BKASH_BASE_URL: "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout/",
      BKASH_APP_KEY: "k", BKASH_APP_SECRET: "s", BKASH_USERNAME: "u", BKASH_PASSWORD: "p",
    };
    it("leaves providers unavailable (null) when unconfigured", () => {
      const env = loadEnv(base);
      expect(env.bkash).toBeNull();
      expect(env.sslcommerz).toBeNull();
    });

    it("enables a provider only when ALL of its credentials are set", () => {
      expect(() => loadEnv({ ...base, BKASH_APP_KEY: "k" })).toThrow(/BKASH_BASE_URL/);
      expect(() => loadEnv({ ...base, SSLCOMMERZ_STORE_ID: "id" })).toThrow(/SSLCOMMERZ_STORE_ID/);
      expect(loadEnv({ ...base, ...bkash }).bkash).toMatchObject({ isLive: false, refundsEnabled: false, authScheme: "bearer", baseUrl: "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout" });
      expect(loadEnv({ ...base, SSLCOMMERZ_STORE_ID: "id", SSLCOMMERZ_STORE_PASSWORD: "pw" }).sslcommerz).toMatchObject({ isLive: false, refundsEnabled: false });
    });

    it("keeps sandbox and live apart", () => {
      expect(() => loadEnv({ ...base, ...bkash, BKASH_IS_LIVE: "true" })).toThrow(/BKASH_IS_LIVE/);
      expect(() => loadEnv({ ...base, ...bkash, BKASH_BASE_URL: "https://tokenized.pay.bka.sh/v2/tokenized-checkout" })).toThrow(/not a sandbox URL/);
      expect(() => loadEnv({ ...base, SSLCOMMERZ_STORE_ID: "id", SSLCOMMERZ_STORE_PASSWORD: "pw", SSLCOMMERZ_IS_LIVE: "true" })).toThrow(/SSLCOMMERZ_IS_LIVE/);
      expect(() => loadEnv({ ...prod, ...bkash, BKASH_IS_LIVE: "true" })).toThrow(/sandbox URL/);
      const live = loadEnv({ ...prod, BKASH_IS_LIVE: "true", BKASH_BASE_URL: "https://tokenized.pay.bka.sh/v2/tokenized-checkout", BKASH_APP_KEY: "k", BKASH_APP_SECRET: "s", BKASH_USERNAME: "u", BKASH_PASSWORD: "p" });
      expect(live.bkash?.isLive).toBe(true);
      expect(loadEnv({ ...prod, SSLCOMMERZ_STORE_ID: "id", SSLCOMMERZ_STORE_PASSWORD: "pw", SSLCOMMERZ_IS_LIVE: "true" }).sslcommerz?.isLive).toBe(true);
    });

    it("only talks to bKash hosts over https", () => {
      expect(() => loadEnv({ ...base, ...bkash, BKASH_BASE_URL: "http://tokenized.sandbox.bka.sh/v2" })).toThrow(/https/);
      expect(() => loadEnv({ ...base, ...bkash, BKASH_BASE_URL: "https://sandbox.evil.example.com/v2" })).toThrow(/bka\.sh/);
      expect(() => loadEnv({ ...base, ...bkash, BKASH_BASE_URL: "not a url" })).toThrow(/valid URL/);
    });
  });
});

describe("AI assistant configuration", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
    FRONTEND_ORIGIN: "http://localhost:3000",
  };
  const ai = { AI_SERVICE_URL: "http://localhost:8000", AI_SERVICE_TOKEN: "a".repeat(40), APP_API_SERVICE_TOKEN: "b".repeat(40) };

  it("is unavailable (null) unless URL and both tokens are set", () => {
    expect(loadEnv(base).ai).toBeNull();
    expect(() => loadEnv({ ...base, AI_SERVICE_URL: ai.AI_SERVICE_URL })).toThrow(/Set all of AI_SERVICE_URL/);
    expect(() => loadEnv({ ...base, AI_SERVICE_TOKEN: ai.AI_SERVICE_TOKEN })).toThrow(/Set all of AI_SERVICE_URL/);
    expect(loadEnv({ ...base, ...ai }).ai).toMatchObject({ serviceUrl: "http://localhost:8000", ratePerMinute: 10, timeoutMs: 70_000 });
  });

  it("requires long, distinct secrets and a clean URL", () => {
    expect(() => loadEnv({ ...base, ...ai, AI_SERVICE_TOKEN: "short" })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...base, ...ai, APP_API_SERVICE_TOKEN: ai.AI_SERVICE_TOKEN })).toThrow(/must differ/i);
    expect(() => loadEnv({ ...base, ...ai, AI_SERVICE_URL: "ftp://x" })).toThrow(/http\(s\)/);
    expect(() => loadEnv({ ...base, ...ai, AI_SERVICE_URL: "http://user:pw@host:8000" })).toThrow(/credentials/);
    expect(() => loadEnv({ ...base, ...ai, AI_RATE_LIMIT_PER_MINUTE: "0" })).toThrow(/AI_RATE_LIMIT_PER_MINUTE/);
  });

  it("never echoes a secret in the error text", () => {
    try {
      loadEnv({ ...base, ...ai, APP_API_SERVICE_TOKEN: "tiny" });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain(ai.AI_SERVICE_TOKEN);
      expect(String(error)).not.toContain("tiny");
    }
  });
});

describe("operational settings", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "http://localhost:3000",
    FRONTEND_ORIGIN: "http://localhost:3000",
  };

  it("has safe database defaults: bounded pool, connect timeout and statement timeout", () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ DATABASE_POOL_MAX: 10, DATABASE_CONNECT_TIMEOUT_MS: 5000, DATABASE_STATEMENT_TIMEOUT_MS: 15000 });
  });

  it("rejects values that would disable the protections", () => {
    expect(() => loadEnv({ ...base, DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => loadEnv({ ...base, DATABASE_POOL_MAX: "1000" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => loadEnv({ ...base, DATABASE_CONNECT_TIMEOUT_MS: "0" })).toThrow(/DATABASE_CONNECT_TIMEOUT_MS/);
    expect(() => loadEnv({ ...base, DATABASE_STATEMENT_TIMEOUT_MS: "10" })).toThrow(/DATABASE_STATEMENT_TIMEOUT_MS/);
  });

  it("access logging is explicit true/false only", () => {
    expect(loadEnv({ ...base, HTTP_LOG: "true" }).HTTP_LOG).toBe(true);
    expect(() => loadEnv({ ...base, HTTP_LOG: "yes" })).toThrow(/HTTP_LOG/);
  });
});
