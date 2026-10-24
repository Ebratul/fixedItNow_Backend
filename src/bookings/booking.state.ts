import type { ActorRole, BookingStatus } from "../generated/prisma/client.js";

/**
 * THE booking state machine. Every status change in the system goes through
 * `assertTransition`; there is no endpoint that accepts a client-supplied
 * status. See docs/BOOKINGS.md for the diagram.
 */
export type BookingAction =
  | "accept" //            worker accepts a fixed/hourly request
  | "decline" //           worker declines a request
  | "quote" //             worker sends / revises a quote
  | "withdraw_quote" //    worker withdraws their pending quote
  | "reject_quote" //      customer rejects the pending quote
  | "accept_quote" //      customer accepts the pending quote
  | "cancel" //            either participant (rules differ by role)
  | "start" //             worker starts the job
  | "complete" //          worker reports the job finished
  | "confirm_completion" // customer confirms it
  | "expire" //            system: nobody confirmed before the start time
  | "open_dispute"
  | "dispute_mark_completed"
  | "dispute_cancel"
  | "dispute_restore";

type Rule = { from: BookingStatus[]; to: BookingStatus | "RESTORE"; roles: ActorRole[] };

export const TRANSITIONS: Record<BookingAction, Rule> = {
  accept: { from: ["REQUESTED"], to: "CONFIRMED", roles: ["WORKER"] },
  decline: { from: ["REQUESTED", "QUOTED"], to: "DECLINED", roles: ["WORKER"] },
  quote: { from: ["REQUESTED", "QUOTED"], to: "QUOTED", roles: ["WORKER"] },
  withdraw_quote: { from: ["QUOTED"], to: "REQUESTED", roles: ["WORKER"] },
  reject_quote: { from: ["QUOTED"], to: "REQUESTED", roles: ["CUSTOMER"] },
  accept_quote: { from: ["QUOTED"], to: "CONFIRMED", roles: ["CUSTOMER"] },
  // Customers may cancel before and after confirmation. Workers use `decline`
  // before confirmation and `cancel` only once confirmed.
  cancel: { from: ["REQUESTED", "QUOTED", "CONFIRMED"], to: "CANCELLED", roles: ["CUSTOMER", "WORKER"] },
  start: { from: ["CONFIRMED"], to: "IN_PROGRESS", roles: ["WORKER"] },
  complete: { from: ["IN_PROGRESS"], to: "COMPLETION_PENDING", roles: ["WORKER"] },
  confirm_completion: { from: ["COMPLETION_PENDING"], to: "COMPLETED", roles: ["CUSTOMER"] },
  expire: { from: ["REQUESTED", "QUOTED"], to: "EXPIRED", roles: ["SYSTEM"] },
  open_dispute: {
    from: ["CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING", "COMPLETED"],
    to: "DISPUTED",
    roles: ["CUSTOMER", "WORKER"],
  },
  dispute_mark_completed: { from: ["DISPUTED"], to: "COMPLETED", roles: ["ADMIN"] },
  dispute_cancel: { from: ["DISPUTED"], to: "CANCELLED", roles: ["ADMIN"] },
  dispute_restore: { from: ["DISPUTED"], to: "RESTORE", roles: ["ADMIN", "CUSTOMER", "WORKER"] },
};

/** Statuses whose appointment window is reserved (mirrors the DB exclusion constraint). */
export const RESERVING_STATUSES: BookingStatus[] = ["CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING"];
export const TERMINAL_STATUSES: BookingStatus[] = ["COMPLETED", "CANCELLED", "DECLINED", "EXPIRED"];
/** Statuses a customer sees as "open requests". */
export const OPEN_REQUEST_STATUSES: BookingStatus[] = ["REQUESTED", "QUOTED"];

export function canTransition(action: BookingAction, role: ActorRole, from: BookingStatus): boolean {
  const rule = TRANSITIONS[action];
  return rule.roles.includes(role) && rule.from.includes(from);
}

/** Resolve the target status of an action ("RESTORE" needs the previous status). */
export function targetOf(action: BookingAction, previous?: BookingStatus): BookingStatus {
  const to = TRANSITIONS[action].to;
  if (to === "RESTORE") {
    if (!previous) throw new Error("RESTORE needs the previous status");
    return previous;
  }
  return to;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly action: BookingAction,
    readonly role: ActorRole,
    readonly from: BookingStatus,
  ) {
    super(`Cannot ${action.replaceAll("_", " ")} a booking that is ${from}`);
  }
}

export function assertTransition(action: BookingAction, role: ActorRole, from: BookingStatus): void {
  if (!canTransition(action, role, from)) throw new InvalidTransitionError(action, role, from);
}

export const isReserving = (status: BookingStatus) => RESERVING_STATUSES.includes(status);
