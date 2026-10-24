import { z } from "zod";
import { DIVISIONS } from "../common/constants.js";

/**
 * Contracts for the AI assistant (Step 8).
 *
 * `chatRequestSchema`  - what the browser may send. Strict: unknown keys are 400.
 * `aiResponseSchema`   - what the AI service may answer. Strict as well: the AI
 *                        service is a separate process whose output is validated,
 *                        not trusted. It carries REFERENCES to workers, never facts.
 */

const slug = z.string().regex(/^[a-z0-9-]{1,50}$/);
export const workerId = z.string().regex(/^[0-9a-f-]{36}$/, "Invalid worker id");

export const intentSchema = z
  .object({
    category: slug.nullish(),
    location: z.enum(DIVISIONS).nullish(),
    maxBudgetBdt: z.number().int().min(50).max(1_000_000).nullish(),
    minExperienceYears: z.number().int().min(0).max(60).nullish(),
    sort: z.enum(["experience", "price_asc", "newest"]).nullish(),
    preferredTime: z.string().max(80).nullish(),
    problem: z.string().max(200).nullish(),
  })
  .strict();
export type Intent = z.infer<typeof intentSchema>;

export const chatRequestSchema = z
  .object({
    message: z.string().trim().min(1, "Message is required").max(1000, "Message must be 1000 characters or fewer"),
    intent: intentSchema.optional(),
    locale: z.enum(["auto", "en", "bn"]).default("auto"),
    // "search" = the user edited filters in the UI; re-runs the search without reading free text.
    action: z.enum(["message", "search"]).default("message"),
  })
  .strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;

const FIELDS = ["category", "location", "max_budget_bdt", "min_experience_years"] as const;
const NOTES = [
  "AVAILABILITY_NOT_CHECKED",
  "BOOKING_NOT_SUPPORTED",
  "INTENT_INFERRED",
  "SIMPLE_MODE",
  "CONTACT_DETAILS_PRIVATE",
] as const;

export const aiResponseSchema = z
  .object({
    kind: z.enum(["results", "no_results", "clarification", "answer", "out_of_scope", "refused"]),
    message: z.string().min(1).max(1500),
    language: z.enum(["en", "bn"]),
    intent: intentSchema,
    intentSources: z.record(z.string(), z.enum(["explicit", "inferred", "carried"])),
    clarification: z
      .object({
        field: z.enum(["category", "location"]),
        question: z.string().max(300),
        options: z.array(z.object({ value: z.string().max(60), label: z.string().max(100) }).strict()).max(20),
        blocking: z.boolean(),
      })
      .strict()
      .nullable(),
    recommendations: z
      .array(
        z
          .object({
            workerId,
            slug: z.string().max(100),
            rank: z.number().int().min(1).max(50),
            matchedOn: z.array(z.enum(["CATEGORY", "LOCATION", "BUDGET", "EXPERIENCE"])).max(4),
          })
          .strict(),
      )
      .max(10),
    total: z.number().int().min(0).nullable(),
    relaxations: z
      .array(z.object({ drop: z.enum(FIELDS), matchCount: z.number().int().min(1) }).strict())
      .max(4),
    answer: z
      .object({
        text: z.string().max(1500),
        grounded: z.boolean(),
        // Only site-relative paths: the AI service can never inject an external link.
        sources: z
          .array(
            z
              .object({
                id: z.string().max(100),
                title: z.string().max(200),
                url: z.string().regex(/^\/[a-z0-9\-/]*$/),
              })
              .strict(),
          )
          .max(5),
      })
      .strict()
      .nullable(),
    notes: z.array(z.enum(NOTES)).max(5),
    mode: z.enum(["llm", "simple", "direct"]),
  })
  .strict();
export type AiResponse = z.infer<typeof aiResponseSchema>;

/** The AI service's own error body (`{ code, message }`). */
export const aiErrorSchema = z.object({ code: z.string().max(40) }).passthrough();

export type ChatErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_RATE_LIMITED"
  | "AI_TIMEOUT"
  | "AI_UNAVAILABLE";
