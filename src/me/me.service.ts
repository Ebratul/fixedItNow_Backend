import { Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
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
        customerProfile: {
          select: { displayName: true, preferredDivision: true },
        },
        workerProfile: { select: workerProfileSelect },
      },
    });

    const { role, customerProfile, workerProfile, ...account } = user;
    return {
      user: account,
      isAdmin: role === "ADMIN",
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
