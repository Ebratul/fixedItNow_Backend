import { DISPUTE_WINDOW_DAYS } from "../bookings/booking.config.js";
import type { BookingStatus } from "../generated/prisma/client.js";

/**
 * Chat is tied to ONE booking and exists only once the professional has accepted it.
 *
 *   NOT_OPEN   requested / quoted / declined / expired, or cancelled before it was ever confirmed
 *   OPEN       confirmed, in progress, awaiting payment, and for DISPUTE_WINDOW_DAYS after completion
 *   READ_ONLY  history stays readable but nothing new can be written: after the post-completion
 *              window, after a cancellation of a confirmed booking, and while a dispute is open
 *              (the dispute thread is the channel then, and the record must not move under it)
 *
 * Messages are never edited or deleted (database trigger), so a dispute can rely on them.
 */
export type ChatAccess =
  | { state: "NOT_OPEN"; canRead: false; canSend: false; reason: string | null }
  | { state: "OPEN"; canRead: true; canSend: true; reason: null }
  | { state: "READ_ONLY"; canRead: true; canSend: false; reason: string };

type Input = { status: BookingStatus; confirmedAt: Date | null; completedAt: Date | null; startAt: Date };

export function chatAccess(b: Input, now: Date): ChatAccess {
  const requested = b.status === "REQUESTED" || b.status === "QUOTED";
  if (requested && b.startAt > now) {
    return { state: "NOT_OPEN", canRead: false, canSend: false, reason: "Messaging opens once the professional accepts the booking." };
  }
  // A request that expired, was declined, or was cancelled before confirmation never opens a conversation.
  if (b.confirmedAt === null) return { state: "NOT_OPEN", canRead: false, canSend: false, reason: null };

  switch (b.status) {
    case "CONFIRMED":
    case "IN_PROGRESS":
    case "COMPLETION_PENDING":
      return { state: "OPEN", canRead: true, canSend: true, reason: null };
    case "COMPLETED": {
      const until = (b.completedAt ?? now).getTime() + DISPUTE_WINDOW_DAYS * 86_400_000;
      return now.getTime() <= until
        ? { state: "OPEN", canRead: true, canSend: true, reason: null }
        : { state: "READ_ONLY", canRead: true, canSend: false, reason: `This conversation closed ${DISPUTE_WINDOW_DAYS} days after the booking was completed. You can still read it.` };
    }
    case "DISPUTED":
      return { state: "READ_ONLY", canRead: true, canSend: false, reason: "This booking is in dispute, so the conversation is read-only. Use the dispute thread to reply." };
    case "CANCELLED":
      return { state: "READ_ONLY", canRead: true, canSend: false, reason: "This booking was cancelled, so new messages cannot be sent. You can still read the conversation." };
    default:
      return { state: "NOT_OPEN", canRead: false, canSend: false, reason: null };
  }
}
