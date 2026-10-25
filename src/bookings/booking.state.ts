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
  | "arrive" //            worker reports arriving (a milestone: the status stays CONFIRMED)
  | "start" //             worker starts the job
  | "complete" //          worker reports the job finished: payment is now due
  | "customer_finish" //   customer says the work is done (even before the worker reports it): payment is now due
  | "payment_verified" //  system: a provider-verified payment completes the booking
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
  // Arrival changes no status: CONFIRMED stays CONFIRMED and `arrivedAt` is stamped (so the slot stays reserved
  // and every existing rule for CONFIRMED still applies).
  arrive: { from: ["CONFIRMED"], to: "CONFIRMED", roles: ["WORKER"] },
  start: { from: ["CONFIRMED"], to: "IN_PROGRESS", roles: ["WORKER"] },
  // COMPLETION_PENDING = "work finished, payment due". Only a verified payment (below) leaves it for COMPLETED;
  // nobody can mark a booking completed by asking for it.
  complete: { from: ["IN_PROGRESS"], to: "COMPLETION_PENDING", roles: ["WORKER"] },
  // The customer is the one who pays, so they may declare the work done themselves, e.g. when it finished before
  // the scheduled time and the professional's arrival/start window has not opened. This only makes payment DUE
  // (same status as the worker's report); it completes nothing, and a dispute stays possible.
  customer_finish: { from: ["CONFIRMED", "IN_PROGRESS"], to: "COMPLETION_PENDING", roles: ["CUSTOMER"] },
  payment_verified: { from: ["COMPLETION_PENDING"], to: "COMPLETED", roles: ["SYSTEM"] },
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
/**
 * Statuses whose window other bookings must not take. A DISPUTED booking is not in the DB exclusion
 * constraint (so it never blocks a dispute decision on its own), but it can be restored to a reserving
 * status; if its slot were handed to someone else meanwhile, the restore would fail with SLOT_UNAVAILABLE
 * and the dispute could no longer be withdrawn or rejected. So new bookings treat it as taken.
 */
export const SLOT_HOLDING_STATUSES: BookingStatus[] = [...RESERVING_STATUSES, "DISPUTED"];
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
