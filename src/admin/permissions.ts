/**
 * The admin permission catalogue: the ONE place that names what an administrator may do.
 *
 * - Every `/admin/*` route declares the permission(s) it needs with `@RequirePermission(...)`;
 *   a test fails if a route does not, or if a permission here is used by no route.
 * - A role stores a list of these keys. The system role `super_admin` stores ["*"], which means
 *   "everything in this catalogue, including keys added later".
 * - `sensitive` marks permissions that expose private data or move money; the UI flags them when
 *   a role is edited. It does not change enforcement.
 */
export const PERMISSION_GROUPS = [
  {
    id: "overview",
    label: "Overview",
    permissions: [
      { key: "dashboard.view", label: "View dashboard", description: "Platform metrics and trends (aggregate counts, no personal data)." },
      { key: "ops.read", label: "View operations", description: "Integration health, queues and environment status (never secret values)." },
    ],
  },
  {
    id: "people",
    label: "People and access",
    permissions: [
      { key: "users.read", label: "View users", description: "Search users and see account details including email address.", sensitive: true },
      { key: "users.suspend", label: "Suspend accounts", description: "Suspend or restore user accounts (revokes their sessions)." },
      { key: "roles.read", label: "View admin roles", description: "See admin roles and who holds them." },
      { key: "roles.manage", label: "Manage admin roles", description: "Create, edit and delete admin roles (only with permissions you hold yourself).", sensitive: true },
      { key: "admins.assign", label: "Assign admin access", description: "Give or remove admin access and assign admin roles (only roles within your own permissions).", sensitive: true },
    ],
  },
  {
    id: "workers",
    label: "Workers",
    permissions: [
      { key: "workers.read", label: "View worker applications", description: "Worker queue and profile details." },
      { key: "workers.review", label: "Verify workers", description: "Approve, reject or request resubmission of worker profiles." },
      { key: "workers.suspend", label: "Suspend workers", description: "Hide a worker profile from the public marketplace." },
      { key: "workers.documents.view", label: "View identity documents", description: "Open private NID/identity images. Every view is audited.", sensitive: true },
    ],
  },
  {
    id: "catalog",
    label: "Service catalogue",
    permissions: [
      { key: "catalog.read", label: "View catalogue", description: "Categories and subcategories, including inactive ones." },
      { key: "catalog.manage", label: "Manage catalogue", description: "Create, edit, reorder, deactivate and delete categories and subcategories." },
    ],
  },
  {
    id: "bookings",
    label: "Bookings and disputes",
    permissions: [
      { key: "bookings.read", label: "View bookings", description: "Monitor bookings and their event history.", sensitive: true },
      { key: "disputes.read", label: "View disputes", description: "Dispute queue and conversation." },
      { key: "disputes.manage", label: "Resolve disputes", description: "Review, message, resolve or reject disputes." },
    ],
  },
  {
    id: "finance",
    label: "Payments",
    permissions: [
      { key: "payments.read", label: "View payments and refunds", description: "Payment transactions, events and refund requests.", sensitive: true },
      { key: "payments.reconcile", label: "Re-verify payments", description: "Ask the payment provider for the real status of a payment." },
      { key: "refunds.decide", label: "Approve or reject refunds", description: "Decide refund requests (financial decision).", sensitive: true },
      { key: "refunds.process", label: "Process refunds", description: "Send an approved refund to the payment provider (moves money).", sensitive: true },
      { key: "finance.reports", label: "Financial reports", description: "Revenue and commission reports.", sensitive: true },
    ],
  },
  {
    id: "support",
    label: "Support",
    permissions: [
      { key: "support.read", label: "View support tickets", description: "Tickets and complaints raised by users.", sensitive: true },
      { key: "support.manage", label: "Handle support tickets", description: "Reply, assign, change priority and close tickets." },
    ],
  },
  {
    id: "community",
    label: "Community",
    permissions: [
      { key: "moderation.read", label: "View reports and content", description: "Reports queue, posts, comments, reviews and proposals." },
      { key: "moderation.manage", label: "Moderate content", description: "Hide or restore content, decide reports and feature proposals." },
    ],
  },
  {
    id: "ai",
    label: "AI assistant",
    permissions: [
      { key: "ai.read", label: "View AI knowledge base", description: "Knowledge documents and AI service health." },
      { key: "ai.manage", label: "Manage AI knowledge base", description: "Edit, publish and sync knowledge documents to the AI service." },
    ],
  },
  {
    id: "comms",
    label: "Communication",
    permissions: [
      { key: "notifications.manage", label: "Announcements and notifications", description: "Publish announcements and send a notification to a user." },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    permissions: [
      { key: "audit.read", label: "View audit log", description: "Search the admin audit trail.", sensitive: true },
      { key: "audit.verify", label: "Verify audit integrity", description: "Run the audit-log hash-chain check." },
      { key: "settings.read", label: "View platform settings", description: "Current values of platform settings." },
      { key: "settings.manage", label: "Change platform settings", description: "Change platform settings such as maintenance mode.", sensitive: true },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["permissions"][number]["key"];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key)) as Permission[];
const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export const WILDCARD = "*";
export const SUPER_ADMIN_KEY = "super_admin";

export const isPermission = (value: string): value is Permission => PERMISSION_SET.has(value);

/**
 * Stored role permissions -> the effective set. "*" expands to the whole catalogue; keys that are
 * no longer in the catalogue (a permission that was removed in a later release) are ignored, so a
 * stale row can never grant something the code does not know.
 */
export function expandPermissions(stored: readonly string[]): ReadonlySet<Permission> {
  if (stored.includes(WILDCARD)) return new Set(ALL_PERMISSIONS);
  return new Set(stored.filter(isPermission));
}

/** True when `candidate` grants nothing the `holder` lacks (the anti-escalation rule). */
export function isSubset(candidate: ReadonlySet<Permission>, holder: ReadonlySet<Permission>): boolean {
  for (const permission of candidate) if (!holder.has(permission)) return false;
  return true;
}

/**
 * Editable starting roles, created by the seed script only if missing (never overwritten, so
 * edits made in the admin panel survive a re-seed). `super_admin` is created by the migration.
 */
export const DEFAULT_ROLES: readonly { key: string; name: string; description: string; permissions: Permission[] }[] = [
  {
    key: "operations_admin",
    name: "Operations admin",
    description: "Runs the marketplace day to day: people, workers, catalogue, bookings, disputes, support and moderation. No money movement and no role management.",
    permissions: [
      "dashboard.view", "ops.read", "users.read", "users.suspend", "roles.read",
      "workers.read", "workers.review", "workers.suspend", "catalog.read", "catalog.manage",
      "bookings.read", "disputes.read", "disputes.manage", "support.read", "support.manage",
      "moderation.read", "moderation.manage", "notifications.manage", "ai.read", "settings.read",
    ],
  },
  {
    key: "verification_officer",
    name: "Verification officer",
    description: "Reviews worker applications and identity documents.",
    permissions: ["dashboard.view", "workers.read", "workers.review", "workers.documents.view"],
  },
  {
    key: "finance_admin",
    name: "Finance admin",
    description: "Payments, refunds and financial reports.",
    permissions: [
      "dashboard.view", "bookings.read", "payments.read", "payments.reconcile",
      "refunds.decide", "refunds.process", "finance.reports",
    ],
  },
  {
    key: "support_agent",
    name: "Support agent",
    description: "Answers support tickets and complaints and can read bookings for context.",
    permissions: ["dashboard.view", "users.read", "bookings.read", "disputes.read", "support.read", "support.manage"],
  },
  {
    key: "content_moderator",
    name: "Content moderator",
    description: "Moderates community posts, reviews and feature proposals.",
    permissions: ["dashboard.view", "moderation.read", "moderation.manage"],
  },
];
