import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { readSetting } from "../admin/settings/read-setting.js";
import {
  DEMO_KEYS,
  DEMO_MAX_SESSIONS_PER_ROLE,
  DEMO_PROFILES,
  DEMO_SESSION_SECONDS,
  demoRoleOf,
  demoSettingKey,
} from "../demo/demo.config.js";
import type { PrismaService } from "../prisma/prisma.service.js";

export const DEMO_SIGN_IN_PATH = "/demo/sign-in";

/**
 * "Continue as Demo Customer / Worker / Admin" (docs/DEMO.md).
 *
 * A visitor with no account and no password gets a normal Better Auth session for ONE of three fixed demo users. The
 * request carries only a role NAME; the user it maps to is chosen here, from the database, and is never taken from
 * the client. Everything after that is the ordinary authentication machinery: a server-side session row, a signed
 * HttpOnly cookie (Secure in production, SameSite=Lax), the origin/CSRF check, the rate limiter, and the same
 * AuthGuard on every request. What makes a demo session safe is not this endpoint but what happens afterwards:
 * the realm firewall and DemoGuard, which every demo request passes through.
 *
 * The session is a browser-session cookie and expires after DEMO_SESSION_SECONDS; it is never extended.
 */
export function demoLogin(prisma: PrismaService, frontendOrigin: string): BetterAuthPlugin {
  const db = prisma.unscoped;

  return {
    id: "demo-login",
    endpoints: {
      demoSignIn: createAuthEndpoint(
        DEMO_SIGN_IN_PATH,
        {
          method: "POST",
          // Strict: a body naming anything but a role (a user id, a role like "super_admin", extra keys) is a 400.
          body: z.strictObject({ role: z.enum(DEMO_KEYS) }),
        },
        async (ctx) => {
          // Login CSRF: this route needs no credentials, so Better Auth's cookie-based origin check does not cover it. A page on
          // another site must not be able to start (and set the cookie of) a demo session in a visitor's browser, so the
          // request must come from the web app itself, exactly like every other state-changing route (OriginGuard).
          const source = (ctx.request?.headers ?? ctx.headers)?.get("origin") ?? (ctx.request?.headers ?? ctx.headers)?.get("referer");
          let origin: string | undefined;
          try {
            origin = source ? new URL(source).origin : undefined;
          } catch {
            origin = undefined;
          }
          if (origin !== frontendOrigin) throw new APIError("FORBIDDEN", { message: "Cross-origin request rejected", code: "INVALID_ORIGIN" });

          const key = ctx.body.role;
          const profile = DEMO_PROFILES[key];

          // The administrator's switch is the first and decisive check, for hidden and visible options alike.
          if (!(await readSetting(prisma, demoSettingKey(key, "enabled")))) {
            throw new APIError("FORBIDDEN", { message: `${profile.label} is not available right now.`, code: "DEMO_DISABLED" });
          }

          const user = await db.user.findUnique({ where: { demoRole: demoRoleOf(key) } });
          if (!user || !user.isDemo || !user.emailVerified || user.suspendedAt) {
            throw new APIError("SERVICE_UNAVAILABLE", { message: "The demo is not set up on this server.", code: "DEMO_UNAVAILABLE" });
          }

          const current = await getSessionFromCtx(ctx, { disableRefresh: true }).catch(() => null);
          if (current) {
            // Already inside this very demo: nothing to create (a repeated click never makes a second session).
            if (current.user.id === user.id) return ctx.json({ role: key, redirectTo: profile.redirectTo });
            throw new APIError("CONFLICT", { message: "You are already signed in. Log out first to try a demo.", code: "ALREADY_SIGNED_IN" });
          }

          // A public identity must not be a session-flooding target: expired demo sessions are cleared here, and a
          // role never holds more than DEMO_MAX_SESSIONS_PER_ROLE live ones.
          const now = new Date();
          await db.session.deleteMany({ where: { expiresAt: { lt: now }, user: { isDemo: true } } });
          const live = await db.session.count({ where: { userId: user.id, expiresAt: { gt: now } } });
          if (live >= DEMO_MAX_SESSIONS_PER_ROLE) {
            throw new APIError("SERVICE_UNAVAILABLE", { message: "The demo is busy right now. Please try again in a few minutes.", code: "DEMO_BUSY" });
          }

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            true, // browser-session cookie
            { expiresAt: new Date(now.getTime() + DEMO_SESSION_SECONDS * 1000) },
            true, // use the expiry above instead of the default 7 days
          );
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not start the demo session.", code: "DEMO_SESSION_FAILED" });
          await setSessionCookie(ctx, { session, user }, true);

          // No token in the body: the cookie is the only carrier.
          return ctx.json({ role: key, redirectTo: profile.redirectTo });
        },
      ),
    },
    // Rate limiting: the per-IP rule for DEMO_SIGN_IN_PATH is in auth.factory.ts (customRules), next to the others;
    // the global per-role session cap above bounds what a distributed flood could create.
  };
}
