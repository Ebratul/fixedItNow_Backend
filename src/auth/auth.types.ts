import type { DemoRole, UserRole, VerificationStatus, OnboardingStatus } from "../generated/prisma/enums.js";

/** Identity established from a verified session cookie. */
export type AuthContext = {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionId: string;
  /** Always read from the database, never from the session or the client. */
  role: UserRole;
  /** Effective admin permissions (empty for non-admins and for admins without a role). From the database. */
  permissions: readonly string[];
  /**
   * Which public demo identity this is, or null for an ordinary account. From the database, like the role. A demo
   * request runs in the demo realm (see common/request-context.ts) and is subject to DemoGuard.
   */
  demo: DemoRole | null;
};

export type WorkerContext = {
  id: string;
  userId: string;
  onboardingStatus: OnboardingStatus;
  verificationStatus: VerificationStatus;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
    worker?: WorkerContext;
  }
}
