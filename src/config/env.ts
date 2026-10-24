import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().min(1),

    // Auth. BETTER_AUTH_URL is the PUBLIC origin users see (the web app),
    // because the web app proxies /api/v1/* to this service. OAuth redirect
    // URIs and email links are built from it.
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters (try: openssl rand -base64 32)"),
    BETTER_AUTH_URL: z.url(),
    FRONTEND_ORIGIN: z.url(),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,

    // Mail. "console" is for local development only and prints links.
    MAIL_TRANSPORT: z.enum(["smtp", "console"]).optional(),
    EMAIL_FROM: z.string().default("FixedItNow <no-reply@localhost>"),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: boolean.default(false),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,

    // Number of reverse-proxy hops to trust for client IP (rate limiting).
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
    // Comma-separated addresses/CIDRs of reverse proxies whose X-Forwarded-For
    // chain Better Auth may walk to find the client IP (rate limiting).
    TRUSTED_PROXIES: optionalString,
    RATE_LIMIT_ENABLED: boolean.default(true),

    // Payments (Step 6). A provider is ENABLED only when ALL of its credentials
    // are set; with none set it is simply unavailable (nothing is faked).
    // Credentials are server-only secrets and are never returned by any API.
    // bKash tokenized checkout v2. BASE_URL includes the version path, e.g.
    // https://tokenized.sandbox.bka.sh/v2/tokenized-checkout
    BKASH_BASE_URL: optionalString,
    BKASH_APP_KEY: optionalString,
    BKASH_APP_SECRET: optionalString,
    BKASH_USERNAME: optionalString,
    BKASH_PASSWORD: optionalString,
    BKASH_IS_LIVE: boolean.default(false),
    // The bKash docs describe the Authorization header both as "Bearer <id_token>"
    // and (in curl samples) as the raw id_token. Unverified: confirm in the sandbox.
    BKASH_AUTH_SCHEME: z.enum(["bearer", "raw"]).default("bearer"),
    BKASH_REFUNDS_ENABLED: boolean.default(false),
    SSLCOMMERZ_STORE_ID: optionalString,
    SSLCOMMERZ_STORE_PASSWORD: optionalString,
    SSLCOMMERZ_IS_LIVE: boolean.default(false),
    SSLCOMMERZ_REFUNDS_ENABLED: boolean.default(false),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      issue(
        "GOOGLE_CLIENT_ID",
        "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither",
      );
    }
    const transport =
      env.MAIL_TRANSPORT ?? (env.NODE_ENV === "production" ? "smtp" : "console");
    if (transport === "console" && env.NODE_ENV === "production") {
      issue("MAIL_TRANSPORT", "The console mail transport is not allowed in production");
    }
    if (transport === "smtp" && !env.SMTP_HOST) {
      issue("SMTP_HOST", "SMTP_HOST is required when MAIL_TRANSPORT is smtp");
    }
    const bkashCreds = [env.BKASH_BASE_URL, env.BKASH_APP_KEY, env.BKASH_APP_SECRET, env.BKASH_USERNAME, env.BKASH_PASSWORD];
    if (bkashCreds.some(Boolean) && !bkashCreds.every(Boolean)) {
      issue("BKASH_BASE_URL", "Set all of BKASH_BASE_URL, BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, BKASH_PASSWORD, or none");
    }
    if (env.BKASH_BASE_URL) {
      let host = "";
      try {
        const url = new URL(env.BKASH_BASE_URL);
        host = url.hostname;
        if (url.protocol !== "https:") issue("BKASH_BASE_URL", "Must be an https URL");
      } catch {
        issue("BKASH_BASE_URL", "Must be a valid URL");
      }
      if (host && !host.endsWith(".bka.sh")) issue("BKASH_BASE_URL", "Host must be under bka.sh");
      // Sandbox and live must never be mixed up.
      if (host && env.BKASH_IS_LIVE && host.includes("sandbox")) {
        issue("BKASH_BASE_URL", "BKASH_IS_LIVE=true but the URL is a sandbox URL");
      }
      if (host && !env.BKASH_IS_LIVE && !host.includes("sandbox")) {
        issue("BKASH_IS_LIVE", "The URL is not a sandbox URL: set BKASH_IS_LIVE=true if this is the live endpoint");
      }
    }
    if (Boolean(env.SSLCOMMERZ_STORE_ID) !== Boolean(env.SSLCOMMERZ_STORE_PASSWORD)) {
      issue("SSLCOMMERZ_STORE_ID", "Set both SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD, or neither");
    }
    // Live credentials are only accepted by a production deployment.
    if (env.NODE_ENV !== "production") {
      if (env.BKASH_IS_LIVE && env.BKASH_BASE_URL) issue("BKASH_IS_LIVE", "Live bKash is only allowed when NODE_ENV=production");
      if (env.SSLCOMMERZ_IS_LIVE && env.SSLCOMMERZ_STORE_ID) {
        issue("SSLCOMMERZ_IS_LIVE", "Live SSLCOMMERZ is only allowed when NODE_ENV=production");
      }
    }
    if (env.NODE_ENV === "production") {
      if (!env.BETTER_AUTH_URL.startsWith("https://")) {
        issue("BETTER_AUTH_URL", "Must be https in production");
      }
      if (!env.RATE_LIMIT_ENABLED) {
        issue("RATE_LIMIT_ENABLED", "Rate limiting cannot be disabled in production");
      }
      // Without a configured proxy chain Better Auth cannot resolve a
      // trustworthy client IP, and would silently skip rate limiting.
      if (!env.TRUSTED_PROXIES) {
        issue(
          "TRUSTED_PROXIES",
          "Required in production so rate limiting can identify clients (see docs/DEPLOYMENT.md)",
        );
      }
    }
  });

export type Env = Omit<z.infer<typeof schema>, "MAIL_TRANSPORT"> & {
  MAIL_TRANSPORT: "smtp" | "console";
  googleEnabled: boolean;
  frontendOrigin: string;
  trustedProxies: string[];
  /** null = bKash is not configured (unavailable). */
  bkash: {
    baseUrl: string;
    appKey: string;
    appSecret: string;
    username: string;
    password: string;
    isLive: boolean;
    authScheme: "bearer" | "raw";
    refundsEnabled: boolean;
  } | null;
  /** null = SSLCOMMERZ is not configured (unavailable). */
  sslcommerz: { storeId: string; storePassword: string; isLive: boolean; refundsEnabled: boolean } | null;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  return {
    ...env,
    MAIL_TRANSPORT:
      env.MAIL_TRANSPORT ?? (env.NODE_ENV === "production" ? "smtp" : "console"),
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    frontendOrigin: new URL(env.FRONTEND_ORIGIN).origin,
    trustedProxies: (env.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    bkash:
      env.BKASH_BASE_URL && env.BKASH_APP_KEY && env.BKASH_APP_SECRET && env.BKASH_USERNAME && env.BKASH_PASSWORD
        ? {
            baseUrl: env.BKASH_BASE_URL.replace(/\/+$/, ""),
            appKey: env.BKASH_APP_KEY,
            appSecret: env.BKASH_APP_SECRET,
            username: env.BKASH_USERNAME,
            password: env.BKASH_PASSWORD,
            isLive: env.BKASH_IS_LIVE,
            authScheme: env.BKASH_AUTH_SCHEME,
            refundsEnabled: env.BKASH_REFUNDS_ENABLED,
          }
        : null,
    sslcommerz:
      env.SSLCOMMERZ_STORE_ID && env.SSLCOMMERZ_STORE_PASSWORD
        ? {
            storeId: env.SSLCOMMERZ_STORE_ID,
            storePassword: env.SSLCOMMERZ_STORE_PASSWORD,
            isLive: env.SSLCOMMERZ_IS_LIVE,
            refundsEnabled: env.SSLCOMMERZ_REFUNDS_ENABLED,
          }
        : null,
  };
}

export const ENV = Symbol("ENV");
