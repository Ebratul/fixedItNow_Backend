import { describe, expect, it } from "vitest";
import { PROPOSAL_STATUSES, PROPOSAL_TRANSITIONS, VOTING_OPEN } from "./proposals.schemas.js";

describe("proposal lifecycle", () => {
  it("defines transitions for every status and never loops back or skips a decision", () => {
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual([...PROPOSAL_STATUSES].sort());
    for (const [from, to] of Object.entries(PROPOSAL_TRANSITIONS)) expect(to).not.toContain(from);
    expect(PROPOSAL_TRANSITIONS.SUBMITTED).not.toContain("ACCEPTED");
    expect(PROPOSAL_TRANSITIONS.DECLINED).toEqual([]);
    expect(PROPOSAL_TRANSITIONS.COMPLETED).toEqual([]);
  });
  it("keeps voting open only while a proposal awaits a decision", () => {
    expect([...VOTING_OPEN]).toEqual(["SUBMITTED", "UNDER_REVIEW"]);
  });
});
