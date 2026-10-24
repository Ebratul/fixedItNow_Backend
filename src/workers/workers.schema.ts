import { z } from "zod";
import { DIVISIONS } from "../common/constants.js";

export const SORTS = ["newest", "experience", "price_asc", "price_desc"] as const;
export type WorkerSort = (typeof SORTS)[number];

export const MAX_PAGE_SIZE = 48;
export const DEFAULT_PAGE_SIZE = 12;
export const MAX_QUERY_TERMS = 5;

/** Blank/whitespace-only values mean "not provided". */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * Public search query. Every value is validated and bounded; `sort` is a closed
 * enum mapped to fixed ORDER BY clauses in the service, so callers can never
 * choose a column. Unknown query keys are ignored, never used.
 */
export const searchQuerySchema = z.object({
  q: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(80, "Search text must be 80 characters or fewer")
      .optional(),
  ),
  category: z.preprocess(
    blankToUndefined,
    z.string().regex(/^[a-z0-9-]{1,50}$/, "Invalid category").optional(),
  ),
  location: z.preprocess(blankToUndefined, z.enum(DIVISIONS).optional()),
  maxPrice: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(50).max(1_000_000).optional(),
  ),
  minExperience: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).max(60).optional(),
  ),
  sort: z.preprocess(blankToUndefined, z.enum(SORTS).default("newest")),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(500).default(1)),
  pageSize: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Escape LIKE/ILIKE metacharacters. Prisma's `contains` does NOT escape them,
 * so without this a search for "%" or "_" would match every row.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Split free text into at most MAX_QUERY_TERMS lowercase terms. */
export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_TERMS)
    .map(escapeLike);
}

export const paginationSchema = z.object({
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(500).default(1)),
  pageSize: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
});
