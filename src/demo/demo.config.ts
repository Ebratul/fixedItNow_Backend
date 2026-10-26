import type { DemoRole } from "../generated/prisma/enums.js";
import type { Permission } from "../admin/permissions.js";

/**
 * Demo access: the constants that define the three public "Explore Demo" identities (docs/DEMO.md).
 * Code, not environment: changing them changes the documented security boundary and the tests.
 */

/** The value the public API and the web app use for a demo role. */
export const DEMO_KEYS = ["customer", "worker", "admin"] as const;
export type DemoKey = (typeof DEMO_KEYS)[number];

export const demoRoleOf = (key: DemoKey): DemoRole => key.toUpperCase() as DemoRole;
export const demoKeyOf = (role: DemoRole): DemoKey => role.toLowerCase() as DemoKey;
export const isDemoKey = (value: unknown): value is DemoKey => typeof value === "string" && (DEMO_KEYS as readonly string[]).includes(value);

export const DEMO_ROLE_KEY = "demo_admin";

type DemoProfile = {
  label: string;
  description: string;
  /** Where the web app sends the visitor after the session exists. */
  redirectTo: string;
  name: string;
  /** `.invalid` is reserved (RFC 2606): the address can never receive mail, so no mail can ever reach a real person. */
  email: string;
};

export const DEMO_PROFILES: Record<DemoKey, DemoProfile> = {
  customer: {
    label: "Demo Customer",
    description: "Browse professionals, request a booking, chat, pay with a simulated payment and leave a review.",
    redirectTo: "/account",
    name: "Demo Customer",
    email: "demo.customer@demo.fixeditnow.invalid",
  },
  worker: {
    label: "Demo Worker",
    description: "See booking requests, accept or decline, report arrival, finish work and chat with the customer.",
    redirectTo: "/bookings?role=worker",
    name: "Demo Worker",
    email: "demo.worker@demo.fixeditnow.invalid",
  },
  admin: {
    label: "Demo Admin",
    description: "Explore the admin panel with fictional data: dashboard, users, workers, bookings, disputes, payments and support. Read-only.",
    redirectTo: "/admin",
    name: "Demo Admin",
    email: "demo.admin@demo.fixeditnow.invalid",
  },
};

export const DEMO_EMAIL_DOMAIN = "demo.fixeditnow.invalid";
export const isDemoEmail = (email: string) => email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);

/**
 * Everything the demo administrator may ever hold: read-only permissions. The effective permission set is the
 * stored role INTERSECTED with this list, so no database edit can give the demo administrator a write permission.
 * Deliberately absent: roles, ops (environment/integration status), audit (the real admin trail), the catalogue,
 * documents, every *.manage / *.review / *.decide / *.process / *.suspend / *.assign permission.
 */
export const DEMO_ADMIN_PERMISSIONS: readonly Permission[] = [
  "dashboard.view",
  "users.read",
  "workers.read",
  "bookings.read",
  "disputes.read",
  "payments.read",
  "finance.reports",
  "support.read",
  "moderation.read",
  "settings.read",
];

/** A demo session lives this long, and is never extended (the session `updateAge` is a day). */
export const DEMO_SESSION_SECONDS = 2 * 60 * 60;
/** At most this many live sessions per demo role: a shared, public identity must not be a session-flooding target. */
export const DEMO_MAX_SESSIONS_PER_ROLE = 300;
/** Per demo session: state-changing requests allowed in the window (everything else is read-only traffic). */
export const DEMO_WRITE_LIMIT = { count: 60, windowMs: 10 * 60_000 };

/** Setting keys (registry): one visibility and one availability switch per role. */
export const demoSettingKey = (key: DemoKey, field: "visible" | "enabled") => `demo.${key}.${field}` as const;
