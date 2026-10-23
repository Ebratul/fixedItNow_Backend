import { z } from "zod";
import { DIVISIONS, LANGUAGES, MAX_WORKER_SERVICES } from "../common/constants.js";
import { displayNameSchema } from "../me/customer-profile.schema.js";

const unique = <T>(items: T[]) => new Set(items).size === items.length;

export const serviceInputSchema = z
  .strictObject({
    categorySlug: z.string().regex(/^[a-z0-9-]{1,50}$/, "Invalid category"),
    pricingModel: z.enum(["FIXED", "HOURLY", "QUOTE"]),
    basePriceBdt: z
      .number()
      .int("Use whole taka")
      .min(50, "Minimum price is ৳50")
      .max(1_000_000, "Maximum price is ৳1,000,000")
      .nullable()
      .optional(),
    pricingNotes: z.string().trim().max(300, "Use 300 characters or fewer").nullable().optional(),
  })
  .superRefine((service, ctx) => {
    const needsPrice = service.pricingModel !== "QUOTE";
    if (needsPrice && service.basePriceBdt == null) {
      ctx.addIssue({ code: "custom", path: ["basePriceBdt"], message: "Enter a base price" });
    }
    if (!needsPrice && service.basePriceBdt != null) {
      ctx.addIssue({
        code: "custom",
        path: ["basePriceBdt"],
        message: "Quote-based services do not have a base price",
      });
    }
  });

const fields = {
  displayName: displayNameSchema,
  headline: z.string().trim().max(80, "Use 80 characters or fewer").nullable(),
  bio: z.string().trim().max(1000, "Use 1000 characters or fewer").nullable(),
  experienceYears: z.number().int().min(0).max(60).nullable(),
  languages: z
    .array(z.enum(LANGUAGES))
    .max(LANGUAGES.length)
    .refine(unique, "Remove duplicates"),
  serviceAreas: z
    .array(z.enum(DIVISIONS))
    .max(DIVISIONS.length)
    .refine(unique, "Remove duplicates"),
  services: z
    .array(serviceInputSchema)
    .max(MAX_WORKER_SERVICES, `Choose at most ${MAX_WORKER_SERVICES} services`)
    .refine(
      (services) => unique(services.map((s) => s.categorySlug)),
      "Each category can only be listed once",
    ),
};

/**
 * Draft save: any subset of fields. STRICT, so attempts to set
 * `verificationStatus`, `onboardingStatus`, `userId`, `role`, etc. are rejected
 * with 400 rather than silently ignored.
 */
export const workerDraftSchema = z.strictObject({
  displayName: fields.displayName.optional(),
  headline: fields.headline.optional(),
  bio: fields.bio.optional(),
  experienceYears: fields.experienceYears.optional(),
  languages: fields.languages.optional(),
  serviceAreas: fields.serviceAreas.optional(),
  services: fields.services.optional(),
  onboardingStep: z.number().int().min(1).max(5).optional(),
});

/** Completeness required before a profile can be submitted for review. */
export const workerSubmitSchema = z.object({
  displayName: fields.displayName,
  headline: fields.headline.optional(),
  bio: z
    .string()
    .trim()
    .min(30, "Describe your work in at least 30 characters")
    .max(1000, "Use 1000 characters or fewer"),
  experienceYears: z.number().int().min(0).max(60),
  languages: fields.languages.min(1, "Choose at least one language"),
  serviceAreas: fields.serviceAreas.min(1, "Choose at least one service area"),
  services: fields.services.min(1, "Add at least one service"),
});

export type WorkerDraftInput = z.infer<typeof workerDraftSchema>;
