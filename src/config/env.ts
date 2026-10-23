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
  };
}

export const ENV = Symbol("ENV");
