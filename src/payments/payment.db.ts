import { randomBytes } from "node:crypto";
import type { ActorRole, PaymentStatus, Prisma } from "../generated/prisma/client.js";
import {
  assertPaymentTransition,
  InvalidPaymentTransitionError,
} from "./payment.state.js";
import { conflict } from "../bookings/domain-errors.js";

export type Tx = Prisma.TransactionClient;
export type Actor = { userId: string | null; role: ActorRole };
export const SYSTEM: Actor = { userId: null, role: "SYSTEM" };

/** Opaque, unguessable public reference (96 bits). 27 chars: within both providers' 30-char limit. */
export const newReference = (prefix: "FIN" | "RFD") => prefix + randomBytes(12).toString("hex").toUpperCase();

/**
 * Lock order is ALWAYS booking, then payment. Everything that decides "is this
 * booking paid?" takes the booking lock first, which serialises concurrent
 * callbacks / initiations for one booking.
 */
export async function lockBooking(tx: Tx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM booking WHERE id = ${bookingId} FOR UPDATE`;
}
export async function lockPayment(tx: Tx, paymentId: string) {
  await tx.$queryRaw`SELECT id FROM payment WHERE id = ${paymentId} FOR UPDATE`;
}

export type EventInput = {
  type: string;
  from?: PaymentStatus | null;
  to?: PaymentStatus | null;
  refundId?: string | null;
  /** When given, recording the same fact twice is a silent no-op. */
  dedupeKey?: string;
  /** Sanitised, small, and built by us: never a provider payload. */
  metadata?: Prisma.InputJsonValue;
};

/** Append to the immutable payment history. Returns true when a row was written. */
export async function recordEvent(tx: Tx, paymentId: string, actor: Actor, event: EventInput): Promise<boolean> {
  const { count } = await tx.paymentEvent.createMany({
    data: [
      {
        paymentId,
        type: event.type,
        fromStatus: event.from ?? null,
        toStatus: event.to ?? null,
        refundId: event.refundId ?? null,
        actorUserId: actor.userId,
        actorRole: actor.role,
        dedupeKey: event.dedupeKey ?? null,
        metadata: event.metadata,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

/**
 * Move a payment through the state machine. The UPDATE is conditional on the
 * status we read, so a concurrent change affects 0 rows instead of being
 * overwritten. Callers hold the payment row lock, so this should not race;
 * the condition is the backstop.
 */
export async function changeStatus(
  tx: Tx,
  payment: { id: string; status: PaymentStatus },
  to: PaymentStatus,
  actor: Actor,
  event: Omit<EventInput, "from" | "to">,
  data: Prisma.PaymentUncheckedUpdateManyInput = {},
): Promise<void> {
  try {
    assertPaymentTransition(payment.status, to);
  } catch (error) {
    if (error instanceof InvalidPaymentTransitionError) throw conflict("INVALID_PAYMENT_TRANSITION", error.message);
    throw error;
  }
  const { count } = await tx.payment.updateMany({
    where: { id: payment.id, status: payment.status },
    data: { ...data, status: to },
  });
  if (count === 0) throw conflict("STALE_PAYMENT", "This payment just changed. Please refresh.");
  await recordEvent(tx, payment.id, actor, { ...event, from: payment.status, to });
}
