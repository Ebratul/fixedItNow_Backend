import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Env } from "../config/env.js";
import type { MailService } from "../mail/mail.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";

export const AUTH_BASE_PATH = "/api/v1/auth";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Builds the Better Auth instance. Better Auth owns: password hashing (scrypt),
 * session cookies, email-verification and reset tokens, Google OAuth (state +
 * PKCE), CSRF/origin checks, and auth-endpoint rate limiting. FixedItNow code
 * adds mail delivery, policy choices, and (separately) authorization.
 */
export function createAuth(env: Env, prisma: PrismaService, mail: MailService) {
  const production = env.NODE_ENV === "production";

  return betterAuth({
    appName: "FixedItNow",
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, { provider: "postgresql" }),

    // Origin check for cookie-authenticated requests and redirect allow-list
    // for callbackURL / redirectTo / errorCallbackURL.
    trustedOrigins: [env.frontendOrigin],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      // Sign-in is refused until the email is verified. With this on (and
      // autoSignIn off) sign-up returns the same response whether or not the
      // email already exists, preventing account enumeration.
      requireEmailVerification: true,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: HOUR,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        void mail.send({
          kind: "reset-password",
          to: user.email,
          subject: "Reset your FixedItNow password",
          text: [
            `Hi ${user.name},`,
            "",
            "We received a request to reset your FixedItNow password.",
            `Reset it here (valid for 1 hour): ${url}`,
            "",
            "If you did not ask for this, you can ignore this email.",
          ].join("\n"),
        });
      },
      // Tell the real owner instead of the (possibly malicious) requester.
      onExistingUserSignUp: async ({ user }) => {
        void mail.send({
          kind: "account-notice",
          to: user.email,
          subject: "Someone tried to sign up with your email",
          text: [
            `Hi ${user.name},`,
            "",
            "Someone tried to create a FixedItNow account using this email address, but you already have one.",
            "If it was you, log in or use 'Forgot password'. If not, you can ignore this email.",
          ].join("\n"),
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      // The web app resends explicitly (with its own callbackURL) when login
      // is blocked for an unverified email, so we don't also auto-send here.
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      expiresIn: HOUR,
      sendVerificationEmail: async ({ user, url }) => {
        void mail.send({
          kind: "verify-email",
          to: user.email,
          subject: "Verify your FixedItNow email",
          text: [
            `Hi ${user.name},`,
            "",
            `Confirm your email to finish creating your account (valid for 1 hour): ${url}`,
            "",
            "If you did not sign up, you can ignore this email.",
          ].join("\n"),
        });
      },
    },

    socialProviders: env.googleEnabled
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            // Only identity scopes (openid, email, profile) are requested.
            prompt: "select_account",
          },
        }
      : {},

    account: {
      accountLinking: {
        enabled: true,
        // Never auto-merge a Google sign-in into an existing account because
        // the emails match: that would allow account pre-hijacking. A signed-in
        // user links Google explicitly from their account page instead.
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        trustedProviders: [],
      },
    },

    session: {
      expiresIn: 7 * DAY,
      updateAge: DAY,
      freshAge: 15 * MINUTE,
      // Off so that revoking a session (logout, password reset) takes effect
      // immediately on every request.
      cookieCache: { enabled: false },
    },

    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      window: MINUTE,
      max: 100,
      storage: production ? "database" : "memory",
      customRules: {
        "/sign-in/email": { window: MINUTE, max: 5 },
        "/sign-up/email": { window: MINUTE, max: 5 },
        "/request-password-reset": { window: 5 * MINUTE, max: 3 },
        "/reset-password": { window: MINUTE, max: 5 },
        "/send-verification-email": { window: 5 * MINUTE, max: 3 },
      },
    },

    advanced: {
      // Explicit, because Better Auth silently turns the origin check OFF when
      // NODE_ENV=test unless this is set. Never disable these.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: production,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
        ...(env.trustedProxies.length > 0 && { trustedProxies: env.trustedProxies }),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export const AUTH = Symbol("AUTH");
