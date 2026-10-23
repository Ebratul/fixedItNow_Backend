import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { workerProfileSelect } from "../me/me.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  workerSubmitSchema,
  type WorkerDraftInput,
} from "./worker-profile.schema.js";

/** States in which the owner may (re)submit for review. */
const SUBMITTABLE = new Set(["NOT_SUBMITTED", "RESUBMISSION_REQUIRED"]);

@Injectable()
export class WorkerProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Saves onboarding progress to the CALLER's worker profile, creating it on
   * first save. Verification fields are not writable here.
   */
  async saveDraft(auth: AuthContext, input: WorkerDraftInput) {
    const { services, ...scalars } = input;

    const categories = services
      ? await this.resolveCategories(services.map((s) => s.categorySlug))
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.workerProfile.upsert({
        where: { userId: auth.userId },
        create: { userId: auth.userId, ...scalars },
        update: scalars,
        select: { id: true },
      });

      if (services && categories) {
        await tx.workerService.deleteMany({ where: { workerProfileId: profile.id } });
        await tx.workerService.createMany({
          data: services.map((service) => ({
            workerProfileId: profile.id,
            categoryId: categories.get(service.categorySlug)!,
            pricingModel: service.pricingModel,
            basePriceBdt: service.basePriceBdt ?? null,
            pricingNotes: service.pricingNotes ?? null,
          })),
        });
      }

      return tx.workerProfile.findUniqueOrThrow({
        where: { id: profile.id },
        select: workerProfileSelect,
      });
    });
  }

  /**
   * Submits the caller's profile for review. This marks onboarding complete and
   * the profile PENDING review; it does NOT approve it. Only an admin review
   * (see AdminService) can set VERIFIED.
   */
  async submit(auth: AuthContext) {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: auth.userId },
      select: { ...workerProfileSelect, verificationStatus: true },
    });
    if (!profile) throw new BadRequestException("Start your worker profile first");
    if (!SUBMITTABLE.has(profile.verificationStatus)) {
      throw new ConflictException("This profile has already been submitted");
    }

    const parsed = workerSubmitSchema.safeParse({
      displayName: profile.displayName ?? undefined,
      headline: profile.headline,
      bio: profile.bio ?? undefined,
      experienceYears: profile.experienceYears ?? undefined,
      languages: profile.languages,
      serviceAreas: profile.serviceAreas,
      services: profile.services.map((s) => ({
        categorySlug: s.category.slug,
        pricingModel: s.pricingModel,
        basePriceBdt: s.basePriceBdt,
        pricingNotes: s.pricingNotes,
      })),
    });
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Profile is incomplete",
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    return this.prisma.workerProfile.update({
      where: { userId: auth.userId },
      data: {
        onboardingStatus: "SUBMITTED",
        onboardingStep: 5,
        submittedAt: new Date(),
        verificationStatus: "PENDING",
        reviewNote: null,
      },
      select: workerProfileSelect,
    });
  }

  private async resolveCategories(slugs: string[]) {
    const found = await this.prisma.serviceCategory.findMany({
      where: { slug: { in: slugs }, isActive: true },
      select: { id: true, slug: true },
    });
    const bySlug = new Map(found.map((c) => [c.slug, c.id]));
    const unknown = slugs.filter((slug) => !bySlug.has(slug));
    if (unknown.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        errors: [{ path: "services", message: "Unknown service category" }],
      });
    }
    return bySlug;
  }
}
