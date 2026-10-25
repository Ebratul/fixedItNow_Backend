import { describe, expect, it } from "vitest";
import type { ActorRole, BookingStatus } from "../generated/prisma/client.js";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isReserving,
  RESERVING_STATUSES,
  targetOf,
  TRANSITIONS,
  type BookingAction,
} from "./booking.state.js";
import { ACTIVE_DISPUTE, canDisputeTransition } from "./dispute.state.js";
import { isExclusionViolation } from "./domain-errors.js";

const STATUSES: BookingStatus[] = ["REQUESTED", "QUOTED", "CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING", "COMPLETED", "CANCELLED", "DECLINED", "EXPIRED", "DISPUTED"];
const TERMINAL: BookingStatus[] = ["CANCELLED", "DECLINED", "EXPIRED"];
const ROLES: ActorRole[] = ["CUSTOMER", "WORKER", "ADMIN", "SYSTEM"];
const ACTIONS = Object.keys(TRANSITIONS) as BookingAction[];

describe("booking state machine", () => {
  it("terminal statuses allow no action at all", () => {
    for (const status of TERMINAL) {
      for (const action of ACTIONS) for (const role of ROLES) expect(canTransition(action, role, status), `${action}/${role}/${status}`).toBe(false);
    }
  });

  it("COMPLETED can only lead to DISPUTED (inside the dispute window)", () => {
    const allowed = ACTIONS.filter((a) => ROLES.some((r) => canTransition(a, r, "COMPLETED")));
    expect(allowed).toEqual(["open_dispute"]);
  });

  it("DISPUTED can only be left by the dispute actions", () => {
    const allowed = ACTIONS.filter((a) => ROLES.some((r) => canTransition(a, r, "DISPUTED"))).sort();
    expect(allowed).toEqual(["dispute_cancel", "dispute_mark_completed", "dispute_restore"]);
    // Customers and workers cannot complete or cancel a disputed booking themselves.
    for (const action of ["payment_verified", "customer_finish", "arrive", "complete", "cancel", "start"] as const) {
      for (const role of ["CUSTOMER", "WORKER"] as const) expect(canTransition(action, role, "DISPUTED")).toBe(false);
    }
  });

  it("the customer cannot perform worker-only actions and vice versa", () => {
    for (const status of STATUSES) {
      for (const action of ["accept", "decline", "quote", "withdraw_quote", "arrive", "start", "complete"] as const) {
        expect(canTransition(action, "CUSTOMER", status)).toBe(false);
      }
      for (const action of ["accept_quote", "reject_quote"] as const) {
        expect(canTransition(action, "WORKER", status)).toBe(false);
      }
    }
  });

  it("only admins can apply dispute outcomes (parties can only restore on withdrawal)", () => {
    for (const role of ["CUSTOMER", "WORKER", "SYSTEM"] as const) {
      expect(canTransition("dispute_mark_completed", role, "DISPUTED")).toBe(false);
      expect(canTransition("dispute_cancel", role, "DISPUTED")).toBe(false);
    }
    expect(canTransition("dispute_mark_completed", "ADMIN", "DISPUTED")).toBe(true);
  });

  it("the happy path is exactly REQUESTED -> CONFIRMED -> IN_PROGRESS -> COMPLETION_PENDING (payment due) -> COMPLETED (paid)", () => {
    expect(targetOf("accept")).toBe("CONFIRMED");
    expect(targetOf("start")).toBe("IN_PROGRESS");
    expect(targetOf("complete")).toBe("COMPLETION_PENDING");
    expect(targetOf("payment_verified")).toBe("COMPLETED");
    expect(canTransition("start", "WORKER", "REQUESTED")).toBe(false); // cannot skip confirmation
    expect(canTransition("payment_verified", "SYSTEM", "IN_PROGRESS")).toBe(false); // cannot skip the worker's report
  });

  it("payment, and only payment, completes a booking: the system role alone, only from COMPLETION_PENDING", () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        expect(canTransition("payment_verified", role, status), `${role}/${status}`).toBe(role === "SYSTEM" && status === "COMPLETION_PENDING");
      }
    }
    // No participant or administrator action leads from the working states to COMPLETED.
    const toCompleted = ACTIONS.filter((a) => TRANSITIONS[a].to === "COMPLETED").sort();
    expect(toCompleted).toEqual(["dispute_mark_completed", "payment_verified"]);
    expect(ACTIONS).not.toContain("confirm_completion");
  });

  it("the customer may declare the work finished from CONFIRMED or IN_PROGRESS only, which makes payment due and completes nothing", () => {
    for (const status of STATUSES) {
      for (const role of ROLES) expect(canTransition("customer_finish", role, status), `${role}/${status}`).toBe(role === "CUSTOMER" && (status === "CONFIRMED" || status === "IN_PROGRESS"));
    }
    expect(targetOf("customer_finish")).toBe("COMPLETION_PENDING");
    expect(ACTIONS.filter((a) => TRANSITIONS[a].to === "COMPLETED").sort()).toEqual(["dispute_mark_completed", "payment_verified"]);
  });

  it("arrival is a worker-only milestone on a CONFIRMED booking and changes no status", () => {
    for (const status of STATUSES) {
      for (const role of ROLES) expect(canTransition("arrive", role, status), `${role}/${status}`).toBe(role === "WORKER" && status === "CONFIRMED");
    }
    expect(targetOf("arrive")).toBe("CONFIRMED");
  });

  it("RESTORE returns the previous status and requires it", () => {
    expect(targetOf("dispute_restore", "IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(() => targetOf("dispute_restore")).toThrow();
  });

  it("assertTransition throws a descriptive error", () => {
    expect(() => assertTransition("start", "WORKER", "CANCELLED")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("start", "WORKER", "CANCELLED")).toThrow(/start a booking that is CANCELLED/);
    expect(() => assertTransition("start", "WORKER", "CONFIRMED")).not.toThrow();
  });

  it("only confirmed/in-progress/completion-pending bookings reserve a slot (matches the DB constraint)", () => {
    expect(RESERVING_STATUSES).toEqual(["CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING"]);
    for (const s of STATUSES) expect(isReserving(s)).toBe(RESERVING_STATUSES.includes(s));
  });
});

describe("dispute state machine", () => {
  it("terminal dispute statuses accept nothing", () => {
    for (const status of ["RESOLVED", "REJECTED", "CLOSED"] as const) {
      for (const action of ["review", "request_info", "provide_info", "resolve", "reject", "withdraw"] as const) {
        expect(canDisputeTransition(action, status)).toBe(false);
      }
    }
  });
  it("resolution requires a review first", () => {
    expect(canDisputeTransition("resolve", "OPEN")).toBe(false);
    expect(canDisputeTransition("resolve", "UNDER_REVIEW")).toBe(true);
    expect(ACTIVE_DISPUTE).toEqual(["OPEN", "UNDER_REVIEW", "WAITING_FOR_INFORMATION"]);
  });
});

describe("isExclusionViolation", () => {
  it("recognises the constraint error wherever the driver nests it", () => {
    expect(isExclusionViolation(new Error('conflicting key value violates exclusion constraint "booking_no_overlap"'))).toBe(true);
    expect(isExclusionViolation({ code: "P2010", message: "x", cause: { message: "ERROR 23P01" } })).toBe(true);
    expect(isExclusionViolation(new Error("something else"))).toBe(false);
    expect(isExclusionViolation(undefined)).toBe(false);
  });
});
