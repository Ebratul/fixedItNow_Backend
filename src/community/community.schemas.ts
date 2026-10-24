import { z } from "zod";
import { optionalUserText, userText } from "../common/user-text.js";

export const POST_TITLE = { min: 3, max: 120 } as const;
export const POST_BODY_MAX = 5000;
export const COMMENT_BODY_MAX = 1000;
export const REPORT_DETAILS_MAX = 500;

export const REACTION_TYPES = ["LIKE"] as const;
export const REPORT_REASONS = ["SPAM", "ABUSE", "FRAUD", "INAPPROPRIATE", "PRIVACY", "OTHER"] as const;
export const COMMUNITY_REPORT_TARGETS = ["POST", "COMMENT", "PROPOSAL"] as const;

// Strict objects: author, status, counts, moderation fields... sent by a client are 400, not ignored.
export const createPostSchema = z.strictObject({
  title: userText(POST_TITLE.min, POST_TITLE.max, "Title"),
  body: userText(1, POST_BODY_MAX, "Post"),
});
export const updatePostSchema = z
  .strictObject({
    title: userText(POST_TITLE.min, POST_TITLE.max, "Title").optional(),
    body: userText(1, POST_BODY_MAX, "Post").optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, { message: "Nothing to change" });

export const commentSchema = z.strictObject({ body: userText(1, COMMENT_BODY_MAX, "Comment") });
export const reactionSchema = z.strictObject({ type: z.enum(REACTION_TYPES).default("LIKE") });

export const postListQuery = z.object({
  scope: z.enum(["all", "mine"]).default("all"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(30).default(10),
});
export const commentListQuery = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const reportBodySchema = z.strictObject({
  reason: z.enum(REPORT_REASONS),
  details: optionalUserText(REPORT_DETAILS_MAX, "Details"),
});
export const communityReportSchema = z.strictObject({
  targetType: z.enum(COMMUNITY_REPORT_TARGETS),
  targetId: z.uuid("Invalid content id"),
  reason: z.enum(REPORT_REASONS),
  details: optionalUserText(REPORT_DETAILS_MAX, "Details"),
});
export type CommunityReport = z.infer<typeof communityReportSchema>;
export type ReportBody = z.infer<typeof reportBodySchema>;
