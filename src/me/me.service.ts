import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { demoKeyOf } from "../demo/demo.config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CustomerProfileInput } from "./customer-profile.schema.js";

export const workerProfileSelect = {
  id: true,
  onboardingStatus: true,
  onboardingStep: true,
  displayName: true,
  headline: true,
  bio: true,
  experienceYears: true,
  languages: true,
  serviceAreas: true,
  submittedAt: true,
  verificationStatus: true,
  reviewNote: true,
  // Public-listing state. suspensionReason is internal and deliberately absent.
  slug: true,
  publishedAt: true,
  suspendedAt: true,
  startingPriceBdt: true,
  services: {
    orderBy: { category: { sortOrder: "asc" } },
    select: {
      pricingModel: true,
      basePriceBdt: true,
      pricingNotes: true,
      category: { select: { slug: true, name: true } },
    },
  },
} as const;

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own account summary. Always scoped to `auth.userId`. */
  async getMe(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        demoRole: true,
        adminRole: { select: { key: true, name: true } },
        customerProfile: {
          select: { displayName: true, preferredDivision: true },
        },
        workerProfile: { select: workerProfileSelect },
      },
    });

    const { role, demoRole, adminRole, customerProfile, workerProfile, ...account } = user;
    return {
      user: account,
      isAdmin: role === "ADMIN",
      // Shown so the admin UI can hide what the server would refuse. The server decides, every time. These are the
      // EFFECTIVE permissions from the authentication guard (for the demo administrator: the read-only allow-list).
      admin:
        role === "ADMIN"
          ? { role: adminRole ? { key: adminRole.key, name: adminRole.name } : null, permissions: adminRole ? [...auth.permissions] : [] }
          : null,
      // Non-null only for the public demo identities: the web app shows its "Demo mode" bar from this.
      demo: demoRole ? { role: demoKeyOf(demoRole) } : null,
      customer: customerProfile ? { onboarded: true, profile: customerProfile } : { onboarded: false },
      worker: workerProfile
        ? {
            started: true,
            profile: workerProfile,
            approved:
              workerProfile.onboardingStatus === "SUBMITTED" &&
              workerProfile.verificationStatus === "VERIFIED",
          }
        : { started: false, approved: false },
    };
  }

  /** Creates or updates the caller's own customer profile (idempotent). */
  async upsertCustomerProfile(auth: AuthContext, input: CustomerProfileInput) {
    const data = {
      displayName: input.displayName,
      preferredDivision: input.preferredDivision ?? null,
    };
    return this.prisma.customerProfile.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, ...data },
      update: data,
      select: { displayName: true, preferredDivision: true },
    });
  }
}
