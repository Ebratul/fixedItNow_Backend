import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { readSetting } from "../admin/settings/read-setting.js";
import type { Env } from "../config/env.js";
import type { MailService } from "../mail/mail.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  formatSendState,
  generateOtp,
  makeOtpHasher,
  mayResend,
  nextSendState,
  normalizeEmail,
  parseSendState,
  throttleIdentifier,
} from "./otp.js";

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
      // Sign-in is refused until the email is verified (with the code). With this on (and
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
      // The code itself is sent by the emailOTP plugin (overrideDefaultEmailVerification);
      // no verification LINK exists any more.
      sendOnSignUp: true,
      sendOnSignIn: false,
      // After a correct code the user is signed in (a session cookie is set).
      autoSignInAfterVerification: true,
    },

    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_TTL_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        generateOTP: () => generateOtp(),
        storeOTP: { hash: makeOtpHasher(env.BETTER_AUTH_SECRET) },
        overrideDefaultEmailVerification: true,
        // Never create accounts or sessions from a code alone: this app signs people up with a
        // password (or Google) and uses the code only to prove ownership of the address.
        disableSignUp: true,
        resendStrategy: "rotate",
        sendVerificationOTP: async ({ email, otp, type }, ctx) => {
          if (type !== "email-verification") return; // no other code type is ever mailed
          // Count this send (per ADDRESS) for the resend cooldown / hourly cap enforced in `hooks.before`.
          const adapter = ctx?.context.internalAdapter;
          if (adapter) {
            const id = throttleIdentifier(email);
            const row = await adapter.findVerificationValue(id);
            const live = row && row.expiresAt.getTime() > Date.now() ? row : null;
            const next = nextSendState(parseSendState(live?.value), Date.now());
            await adapter.deleteVerificationByIdentifier(id);
            await adapter.createVerificationValue({
              identifier: id,
              value: formatSendState(next),
              // the hourly window starts at the first send and is not extended by later ones
              expiresAt: live?.expiresAt ?? new Date(Date.now() + HOUR * 1000),
            });
          }
          void mail.send({
            kind: "verify-otp",
            to: email,
            subject: `${otp} is your FixedItNow verification code`,
            text: [
              "Your FixedItNow verification code is:",
              "",
              `    ${otp}`,
              "",
              `It expires in ${OTP_TTL_SECONDS / 60} minutes and works once.`,
              "Only enter it on the FixedItNow page where you just signed up or logged in.",
              "We will never ask you for this code by phone, chat or email.",
              "If you did not request it, you can ignore this email.",
            ].join("\n"),
          });
        },
      }),
    ],

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;

        // (0) Registration can be closed by an administrator (platform setting). Existing users still sign in.
        if (ctx.path === "/sign-up/email" && !(await readSetting(prisma, "platform.registrationsOpen"))) {
          throw new APIError("FORBIDDEN", { message: "New registrations are paused right now. Please try again later.", code: "REGISTRATIONS_CLOSED" });
        }

        // (1) Re-send: only the email-verification code type, only for an account that is
        // actually waiting for verification, and subject to the per-ADDRESS cooldown and hourly cap.
        // Every refusal answers the same `{ success: true }` as a real send and sends nothing, so
        // the endpoint reveals neither whether an account exists nor whether a cooldown applies,
        // and a blocked request cannot replace (invalidate) a code the user already holds.
        if (ctx.path === "/email-otp/send-verification-otp") {
          if (body.type !== "email-verification") {
            throw new APIError("BAD_REQUEST", { message: "Invalid code type", code: "INVALID_OTP_TYPE" });
          }
          if (typeof body.email !== "string") return;
          const email = normalizeEmail(body.email);
          const found = await ctx.context.internalAdapter.findUserByEmail(email);
          if (!found || found.user.emailVerified) return ctx.json({ success: true });
          const row = await ctx.context.internalAdapter.findVerificationValue(throttleIdentifier(email));
          const state = row && row.expiresAt.getTime() > Date.now() ? parseSendState(row.value) : null;
          if (!mayResend(state, Date.now())) return ctx.json({ success: true });
          return;
        }

        // (2) Verify: the caller must ALSO know the account's password. A code alone is not enough,
        // so a stranger who pre-registered someone else's address cannot be "completed" by that
        // person entering a code they were mailed (account pre-hijacking), and a code mailed to
        // you cannot be redeemed by someone who does not hold the account's credentials.
        // A wrong password is answered exactly like a wrong code.
        if (ctx.path === "/email-otp/verify-email") {
          const fail = () => new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });
          if (typeof body.email !== "string" || typeof body.password !== "string") throw fail();
          const found = await ctx.context.internalAdapter.findUserByEmail(normalizeEmail(body.email), { includeAccounts: true });
          const credential = found?.accounts.find((a) => a.providerId === "credential");
          const ok = credential?.password
            ? await ctx.context.password.verify({ hash: credential.password, password: body.password })
            : false;
          if (!ok) throw fail();
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          // A social login whose provider did not verify the email creates NOTHING: an account must
          // never exist for an address nobody has proved they own (Google can report
          // email_verified=false for addresses attached to a Google account without confirmation).
          // Email sign-ups (path /sign-up/email) are created unverified on purpose and verified by code.
          before: async (user, ctx) => {
            if (ctx?.path?.startsWith("/callback/") && user.emailVerified !== true) return false;
            // A first-time Google sign-in creates an account, so it honours the same switch.
            if (ctx?.path?.startsWith("/callback/") && !(await readSetting(prisma, "platform.registrationsOpen"))) return false;
            return undefined;
          },
        },
      },
      session: {
        create: {
          // Runs only AFTER the credentials were accepted, so refusing here reveals nothing to someone
          // who does not know the password. A suspended account gets no new session.
          before: async (session) => {
            const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { suspendedAt: true } });
            if (user?.suspendedAt) {
              throw new APIError("FORBIDDEN", { message: "This account has been suspended. Please contact support.", code: "ACCOUNT_SUSPENDED" });
            }
            return undefined;
          },
        },
      },
    },

    // Routes this app does not use are switched off (404), including the plugin's passwordless
    // OTP sign-in and OTP password reset, and the old verification LINK endpoints.
    disabledPaths: [
      "/verify-email",
      "/send-verification-email",
      "/sign-in/email-otp",
      "/email-otp/check-verification-otp",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/forget-password/email-otp",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
    ],

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
        // Per client IP; the per-ADDRESS cooldown and hourly cap are enforced separately (hooks.before).
        "/email-otp/send-verification-otp": { window: 10 * MINUTE, max: 6 },
        "/email-otp/verify-email": { window: 10 * MINUTE, max: 15 },
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
