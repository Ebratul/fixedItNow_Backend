import { z } from "zod";
import { userText } from "../common/user-text.js";

export const PROPOSAL_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "DECLINED", "PLANNED", "COMPLETED"] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUSES)[number];

/** Voting is open only while a proposal awaits a decision. Afterwards votes are frozen. */
export const VOTING_OPEN: readonly ProposalStatusName[] = ["SUBMITTED", "UNDER_REVIEW"];

/**
 * Reaching this many votes only makes a SUBMITTED proposal appear under
 * "needs review" in the admin queue. It changes no status and triggers nothing
 * (docs/SRS.md FR-COMM-04).
 */
export const REVIEW_VOTE_THRESHOLD = 10;
export const PROPOSALS_PER_DAY = 3;

/** Allowed admin decisions. Everything else is a 409. DECLINED and COMPLETED are final. */
export const PROPOSAL_TRANSITIONS: Record<ProposalStatusName, readonly ProposalStatusName[]> = {
  SUBMITTED: ["UNDER_REVIEW", "DECLINED"],
  UNDER_REVIEW: ["ACCEPTED", "PLANNED", "DECLINED"],
  ACCEPTED: ["PLANNED", "DECLINED"],
  PLANNED: ["COMPLETED", "DECLINED"],
  DECLINED: [],
  COMPLETED: [],
};

export const createProposalSchema = z.strictObject({
  title: userText(5, 120, "Title"),
  description: userText(10, 2000, "Description"),
});

export const proposalListQuery = z.object({
  sort: z.enum(["top", "new"]).default("top"),
  status: z.enum(PROPOSAL_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(30).default(10),
});
