import type { PrismaClient } from "../generated/prisma/client.js";

/**
 * Deletes the data that belongs to demo accounts (never anything else) and returns how many rows went per table.
 * The demo USER rows stay: they carry the immutable realm flags, and deleting a user would try to detach its audit rows,
 * which the append-only audit trail refuses. Everything is selected through `isDemo`, so an ordinary user's record
 * cannot be matched.
 *
 * chat_message and payment_event are append-only by trigger. They are cleared with the trigger disabled INSIDE the one
 * transaction, which also takes the table lock, so nothing can write to them meanwhile and the guard is back when it ends.
 * Run with the unscoped script client; it is an operator tool, never part of a request.
 */
export async function resetDemoData(db: PrismaClient): Promise<Record<string, number>> {
  const demoUser = { isDemo: true } as const;
  const deleted: Record<string, number> = {};
  const done = (table: string, result: { count: number }) => {
    deleted[table] = result.count;
  };

  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "chat_message" DISABLE TRIGGER "chat_message_no_update_delete"`);
      await tx.$executeRawUnsafe(`ALTER TABLE "payment_event" DISABLE TRIGGER "payment_event_no_update_delete"`);
      try {
        const booking = { customer: demoUser };
        const payment = { customer: demoUser };
        done("chat messages", await tx.chatMessage.deleteMany({ where: { booking } }));
        done("payment events", await tx.paymentEvent.deleteMany({ where: { payment } }));
      } finally {
        // Back on before anything else can run in this transaction; the transaction's own end would also restore the
        // DDL if an error rolled it back.
        await tx.$executeRawUnsafe(`ALTER TABLE "chat_message" ENABLE TRIGGER "chat_message_no_update_delete"`);
        await tx.$executeRawUnsafe(`ALTER TABLE "payment_event" ENABLE TRIGGER "payment_event_no_update_delete"`);
      }
      done("refunds", await tx.refund.deleteMany({ where: { payment: { customer: demoUser } } }));
      done("payments", await tx.payment.deleteMany({ where: { customer: demoUser } }));
      done("dispute messages", await tx.disputeMessage.deleteMany({ where: { dispute: { booking: { customer: demoUser } } } }));
      done("disputes", await tx.dispute.deleteMany({ where: { booking: { customer: demoUser } } }));
      done("review revisions", await tx.reviewRevision.deleteMany({ where: { review: { customer: demoUser } } }));
      done("content reports", await tx.contentReport.deleteMany({ where: { reporter: demoUser } }));
      done("reviews", await tx.review.deleteMany({ where: { customer: demoUser } }));
      done("quotes", await tx.quote.deleteMany({ where: { booking: { customer: demoUser } } }));
      done("reschedule requests", await tx.rescheduleRequest.deleteMany({ where: { booking: { customer: demoUser } } }));
      done("booking events", await tx.bookingEvent.deleteMany({ where: { booking: { customer: demoUser } } }));
      done("support messages", await tx.supportTicketMessage.deleteMany({ where: { ticket: { requester: demoUser } } }));
      done("support tickets", await tx.supportTicket.deleteMany({ where: { requester: demoUser } }));
      done("bookings", await tx.booking.deleteMany({ where: { customer: demoUser } }));
      done("post reactions", await tx.postReaction.deleteMany({ where: { user: demoUser } }));
      done("feature votes", await tx.featureVote.deleteMany({ where: { user: demoUser } }));
      done("post comments", await tx.postComment.deleteMany({ where: { author: demoUser } }));
      done("posts", await tx.communityPost.deleteMany({ where: { author: demoUser } }));
      done("proposals", await tx.featureProposal.deleteMany({ where: { author: demoUser } }));
      done("notifications", await tx.notification.deleteMany({ where: { user: demoUser } }));
      done("favorites", await tx.favorite.deleteMany({ where: { user: demoUser } }));
      done("professional profiles", await tx.workerProfile.deleteMany({ where: { user: demoUser } })); // schedule, services, time off cascade
      done("customer profiles", await tx.customerProfile.deleteMany({ where: { user: demoUser } }));
      done("sessions", await tx.session.deleteMany({ where: { user: demoUser } }));
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return deleted;
}
