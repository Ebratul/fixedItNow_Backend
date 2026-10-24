import { z } from "zod";
import { userText } from "../common/user-text.js";
import { PROPOSAL_STATUSES } from "../proposals/proposals.schemas.js";

export const CONTENT_PATHS = { posts: "POST", comments: "COMMENT", reviews: "REVIEW", proposals: "PROPOSAL" } as const;
export type ContentType = (typeof CONTENT_PATHS)[keyof typeof CONTENT_PATHS];

/** Admin queues are always paginated with a fixed small page. */
export const ADMIN_PAGE_SIZE = 25;

const note = (label: string) => userText(3, 500, label);

export const reportListQuery = z.object({
  status: z.enum(["OPEN", "REVIEWING", "ACTIONED", "DISMISSED"]).default("OPEN"),
  targetType: z.enum(["POST", "COMMENT", "REVIEW", "PROPOSAL"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/**
 * REVIEW   : OPEN -> REVIEWING
 * RESOLVE  : OPEN | REVIEWING -> ACTIONED   (a moderator acted; note required)
 * DISMISS  : OPEN | REVIEWING -> DISMISSED  (no violation; note required)
 * `contentAction` is an EXPLICIT, optional visibility change made together with RESOLVE.
 * A report's status never changes content on its own.
 */
export const reportDecisionSchema = z
  .strictObject({
    decision: z.enum(["REVIEW", "RESOLVE", "DISMISS"]),
    note: note("Note").optional(),
    contentAction: z.enum(["HIDE", "RESTORE"]).optional(),
  })
  .refine((b) => b.decision === "REVIEW" || Boolean(b.note), { path: ["note"], message: "A moderation note is required" })
  .refine((b) => b.contentAction === undefined || b.decision === "RESOLVE", {
    path: ["contentAction"],
    message: "A content action is only allowed when resolving",
  });
export type ReportDecision = z.infer<typeof reportDecisionSchema>;

export const visibilitySchema = z.strictObject({ hidden: z.boolean(), reason: note("Reason") });

export const proposalAdminQuery = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  needsReview: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export const proposalStatusSchema = z
  .strictObject({ status: z.enum(PROPOSAL_STATUSES), response: userText(3, 1000, "Response").optional() })
  .refine((b) => b.status !== "DECLINED" || Boolean(b.response), { path: ["response"], message: "A response is required when declining" });
export type ProposalStatusChange = z.infer<typeof proposalStatusSchema>;

export const historyQuery = z.object({
  targetType: z.enum(["CommunityPost", "PostComment", "Review", "FeatureProposal", "ContentReport"]).optional(),
  targetId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
