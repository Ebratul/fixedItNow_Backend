import type { UserRole, VerificationStatus, OnboardingStatus } from "../generated/prisma/enums.js";

/** Identity established from a verified session cookie. */
export type AuthContext = {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionId: string;
  /** Always read from the database, never from the session or the client. */
  role: UserRole;
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
