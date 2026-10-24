import type { DisputeStatus } from "../generated/prisma/client.js";

/**
 * Dispute lifecycle (one dispute per booking):
 *
 *   OPEN --admin review--> UNDER_REVIEW <--party reply-- WAITING_FOR_INFORMATION
 *                              |  \--admin asks--------->/
 *                              +--admin resolve--> RESOLVED   (booking outcome applied)
 *                              +--admin reject---> REJECTED   (booking restored)
 *   OPEN | UNDER_REVIEW | WAITING --opener withdraws--> CLOSED (booking restored)
 *
 * RESOLVED, REJECTED and CLOSED are terminal.
 */
export type DisputeAction = "review" | "request_info" | "provide_info" | "resolve" | "reject" | "withdraw";

export const DISPUTE_TRANSITIONS: Record<DisputeAction, { from: DisputeStatus[]; to: DisputeStatus }> = {
  review: { from: ["OPEN"], to: "UNDER_REVIEW" },
  request_info: { from: ["UNDER_REVIEW"], to: "WAITING_FOR_INFORMATION" },
  provide_info: { from: ["WAITING_FOR_INFORMATION"], to: "UNDER_REVIEW" },
  resolve: { from: ["UNDER_REVIEW", "WAITING_FOR_INFORMATION"], to: "RESOLVED" },
  reject: { from: ["UNDER_REVIEW", "WAITING_FOR_INFORMATION"], to: "REJECTED" },
  withdraw: { from: ["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"], to: "CLOSED" },
};

export const ACTIVE_DISPUTE: DisputeStatus[] = ["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"];

export const canDisputeTransition = (action: DisputeAction, from: DisputeStatus) =>
  DISPUTE_TRANSITIONS[action].from.includes(from);
