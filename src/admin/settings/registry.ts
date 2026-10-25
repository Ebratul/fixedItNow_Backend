import { z } from "zod";
import { FORBIDDEN_TEXT } from "../../common/user-text.js";

/**
 * Platform settings that administrators may change at runtime. This registry is the only place a
 * key exists: the API rejects unknown keys, validates every value with the schema here, and falls
 * back to `default` when nothing (or something invalid) is stored. Every setting has a real effect
 * in the code named in `effect`; nothing here is a placeholder.
 *
 * Secrets and provider credentials are environment variables and are deliberately NOT settings.
 */
export type SettingDefinition<T = unknown> = {
  schema: z.ZodType<T>;
  default: T;
  group: "Platform" | "Workers" | "Finance" | "AI";
  label: string;
  description: string;
  /** Where the value is used (shown to admins so they know what changing it does). */
  effect: string;
  /** Readable by anyone at GET /config/platform (never put anything sensitive in a public setting). */
  public: boolean;
};

const def = <T>(d: SettingDefinition<T>) => d;

export const SETTINGS = {
  "platform.maintenanceMode": def({
    schema: z.boolean(),
    default: false,
    group: "Platform",
    label: "Maintenance mode",
    description: "While on, signed-in non-admin users can still browse but every change they try to make is refused with a maintenance message.",
    effect: "Global guard: writes by non-admin users answer 503 MAINTENANCE. Admins, sign-in and payment-provider callbacks are not affected.",
    public: true,
  }),
  "platform.maintenanceMessage": def({
    schema: z.string().trim().max(200).refine((v) => !FORBIDDEN_TEXT.test(v), "Contains unsupported characters"),
    default: "",
    group: "Platform",
    label: "Maintenance message",
    description: "Shown to users while maintenance mode is on.",
    effect: "Returned by GET /config/platform and in the 503 response.",
    public: true,
  }),
  "platform.registrationsOpen": def({
    schema: z.boolean(),
    default: true,
    group: "Platform",
    label: "New registrations open",
    description: "Turn off to stop new accounts being created (email sign-up and first-time Google sign-in). Existing users can still sign in.",
    effect: "Checked by the authentication hooks before an account is created.",
    public: true,
  }),
  "workers.requireIdentityDocuments": def({
    schema: z.boolean(),
    default: false,
    group: "Workers",
    label: "Require identity documents to verify a worker",
    description: "Off by default: identity documents are optional. When on, a worker must upload both sides of their National ID before they can submit their profile, and an administrator can only approve a worker who has both.",
    effect: "Checked when a worker submits their profile, and when an administrator approves it. Not enforced while document storage (DOCUMENT_ENCRYPTION_KEY) is not configured.",
    public: false,
  }),
  "finance.commissionBps": def({
    schema: z.number().int().min(0).max(5000),
    default: 0,
    group: "Finance",
    label: "Commission rate (basis points)",
    description: "100 = 1%. Used ONLY by the commission report. The platform does not currently charge or deduct any fee.",
    effect: "Default rate for GET /admin/finance/commission.",
    public: false,
  }),
  "ai.assistantEnabled": def({
    schema: z.boolean(),
    default: true,
    group: "AI",
    label: "AI assistant enabled",
    description: "Turn off to stop answering assistant questions (e.g. while the knowledge base is being rewritten).",
    effect: "POST /ai/chat answers 503 when off.",
    public: true,
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]["default"];
