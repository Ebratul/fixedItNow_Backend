import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { unprocessable } from "../bookings/domain-errors.js";
import { workerProfileSelect } from "../me/me.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { canPublish } from "../workers/eligibility.js";
import { newSlug } from "../workers/slug.js";
import { REQUIRED_KINDS, WorkerDocumentsService } from "./worker-documents.service.js";
import {
  workerSubmitSchema,
  type WorkerDraftInput,
} from "./worker-profile.schema.js";

/** States in which the owner may (re)submit for review. */
const SUBMITTABLE = new Set(["NOT_SUBMITTED", "RESUBMISSION_REQUIRED"]);

@Injectable()
export class WorkerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: WorkerDocumentsService,
  ) {}

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
        // Keep the denormalised starting price in step with the services, in
        // the same transaction (powers the indexed price filter/sort).
        const prices = services
          .map((s) => s.basePriceBdt)
          .filter((p): p is number => typeof p === "number");
        await tx.workerProfile.update({
          where: { id: profile.id },
          data: { startingPriceBdt: prices.length ? Math.min(...prices) : null },
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

    // Optional by default; an administrator can make both sides of the ID compulsory before submitting.
    if (await this.documents.documentsRequired()) {
      const uploaded = await this.prisma.workerDocument.findMany({
        where: { workerProfileId: profile.id, kind: { in: [...REQUIRED_KINDS] } },
        select: { kind: true },
      });
      if (REQUIRED_KINDS.some((kind) => !uploaded.some((d) => d.kind === kind))) {
        throw unprocessable("DOCUMENTS_REQUIRED", "Upload both sides of your National ID before submitting your profile.");
      }
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

  /**
   * Owner opts in to public listing. Allowed only for an approved
   * (SUBMITTED + VERIFIED), non-suspended profile; the conditions are part of
   * the UPDATE itself so a concurrent suspension cannot be raced past.
   * Idempotent: republishing keeps the original publishedAt and slug.
   */
  async publish(auth: AuthContext) {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: auth.userId },
      select: {
        id: true,
        displayName: true,
        slug: true,
        publishedAt: true,
        onboardingStatus: true,
        verificationStatus: true,
        suspendedAt: true,
      },
    });
    if (!profile) throw new BadRequestException("Start your worker profile first");
    if (profile.suspendedAt) throw new ForbiddenException("This profile is suspended");
    if (!canPublish(profile)) {
      throw new ConflictException("Only approved profiles can be published");
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // The row is locked while the slug is decided, so concurrent publishes cannot each pick a
        // different slug (the last writer would silently change a slug another request just returned).
        return await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "worker_profile" WHERE "id" = ${profile.id} FOR UPDATE`;
          const fresh = await tx.workerProfile.findUniqueOrThrow({ where: { id: profile.id }, select: { slug: true, publishedAt: true } });
          const result = await tx.workerProfile.updateMany({
            where: { id: profile.id, onboardingStatus: "SUBMITTED", verificationStatus: "VERIFIED", suspendedAt: null },
            data: {
              publishedAt: fresh.publishedAt ?? new Date(),
              slug: fresh.slug ?? newSlug(profile.displayName ?? "worker"),
            },
          });
          if (result.count === 0) {
            throw new ConflictException("Only approved profiles can be published");
          }
          return tx.workerProfile.findUniqueOrThrow({ where: { id: profile.id }, select: workerProfileSelect });
        });
      } catch (error) {
        // Slug collision (unique index): draw a new suffix and retry.
        if ((error as { code?: string }).code !== "P2002" || profile.slug) throw error;
      }
    }
    throw new ConflictException("Could not allocate a public address, please try again");
  }

  /** Owner removes the profile from public listing. Idempotent; keeps the slug. */
  async unpublish(auth: AuthContext) {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: auth.userId },
      select: { id: true },
    });
    if (!profile) throw new BadRequestException("Start your worker profile first");
    return this.prisma.workerProfile.update({
      where: { id: profile.id },
      data: { publishedAt: null },
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
