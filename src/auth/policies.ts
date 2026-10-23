import type { AuthContext, WorkerContext } from "./auth.types.js";

/**
 * Authorization rules as small pure functions, so they are easy to test and to
 * reuse from guards and services. Later steps (bookings, payments, messaging)
 * should add their rules here rather than scattering role checks.
 */

export function canAdminister(auth: Pick<AuthContext, "role">): boolean {
  return auth.role === "ADMIN";
}

/** A worker is "approved" only after submission AND reviewer verification. */
export function isApprovedWorker(
  worker: Pick<WorkerContext, "onboardingStatus" | "verificationStatus">,
): boolean {
  return (
    worker.onboardingStatus === "SUBMITTED" &&
    worker.verificationStatus === "VERIFIED"
  );
}

/** Resource ownership: the resource's owner must be the authenticated user. */
export function isOwner(auth: Pick<AuthContext, "userId">, ownerUserId: string): boolean {
  return auth.userId === ownerUserId;
}

/** Admins may not review their own worker profile (conflict of interest). */
export function canReviewWorker(
  auth: Pick<AuthContext, "role" | "userId">,
  workerUserId: string,
): boolean {
  return canAdminister(auth) && !isOwner(auth, workerUserId);
}
