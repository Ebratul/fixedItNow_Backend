import { z } from "zod";
import { DIVISIONS } from "../common/constants.js";
import { FORBIDDEN_TEXT } from "../common/user-text.js";

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, "Enter at least 2 characters")
  .max(60, "Use 60 characters or fewer")
  .refine((value) => !FORBIDDEN_TEXT.test(value), "Use letters, numbers and common punctuation only");

/** Strict: unknown keys (e.g. role, userId) are rejected, not ignored. */
export const customerProfileSchema = z.strictObject({
  displayName: displayNameSchema,
  preferredDivision: z.enum(DIVISIONS).nullable().optional(),
});

export type CustomerProfileInput = z.infer<typeof customerProfileSchema>;
