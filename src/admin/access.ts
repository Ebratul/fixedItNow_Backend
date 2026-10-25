import type { AuthContext } from "../auth/auth.types.js";
import { expandPermissions, isPermission, isSubset, SUPER_ADMIN_KEY, type Permission } from "./permissions.js";

/** The permissions the signed-in admin really holds (from the database, via AuthGuard). */
export const heldPermissions = (auth: Pick<AuthContext, "permissions">): ReadonlySet<Permission> =>
  new Set(auth.permissions.filter(isPermission));

type RoleLike = { key: string; permissions: readonly string[]; isSystem: boolean };

/**
 * Anti-escalation rule used everywhere roles are created, edited, assigned or revoked:
 * an administrator may only act on a role that is NOT more powerful than their own permissions.
 * The system super-admin role (wildcard, covers future permissions) may only be touched by a
 * super administrator, even if someone has been given every current permission one by one.
 */
export function canActOnRole(actor: Pick<AuthContext, "permissions">, actorRoleKey: string | null, role: RoleLike): boolean {
  if (role.key === SUPER_ADMIN_KEY && actorRoleKey !== SUPER_ADMIN_KEY) return false;
  return isSubset(expandPermissions(role.permissions), heldPermissions(actor));
}

/** The database refuses to remove the last active super administrator; turn that into a 409. */
export function isLastSuperAdminError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { message?: string; cause?: unknown; meta?: unknown };
    if (`${e.message ?? ""} ${JSON.stringify(e.meta ?? "")}`.includes("last active super administrator")) return true;
    current = e.cause;
  }
  return false;
}
