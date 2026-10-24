import type { Prisma } from "../generated/prisma/client.js";

/**
 * The ONE definition of "publicly visible worker".
 *
 * A profile appears in any public read (directory, search, profile page,
 * category counts, favourites lists) only if ALL of these hold:
 *   - the worker finished onboarding (SUBMITTED),
 *   - an authorised reviewer approved it (VERIFIED),
 *   - the owner chose to publish it (publishedAt set),
 *   - an admin has not suspended it (suspendedAt null),
 *   - it has a public slug.
 * Every public query must spread this into its `where`; do not re-implement it.
 */
export const ELIGIBLE_WORKER = {
  onboardingStatus: "SUBMITTED",
  verificationStatus: "VERIFIED",
  publishedAt: { not: null },
  suspendedAt: null,
  slug: { not: null },
} as const satisfies Prisma.WorkerProfileWhereInput;

type Listable = {
  onboardingStatus: string;
  verificationStatus: string;
  publishedAt: Date | null;
  suspendedAt: Date | null;
  slug: string | null;
};

/** In-memory twin of ELIGIBLE_WORKER (kept in sync by tests). */
export function isListable(profile: Listable): boolean {
  return (
    profile.onboardingStatus === "SUBMITTED" &&
    profile.verificationStatus === "VERIFIED" &&
    profile.publishedAt !== null &&
    profile.suspendedAt === null &&
    profile.slug !== null
  );
}

/** Owner may publish only when approved and not suspended. */
export function canPublish(
  profile: Pick<Listable, "onboardingStatus" | "verificationStatus" | "suspendedAt">,
): boolean {
  return (
    profile.onboardingStatus === "SUBMITTED" &&
    profile.verificationStatus === "VERIFIED" &&
    profile.suspendedAt === null
  );
}
