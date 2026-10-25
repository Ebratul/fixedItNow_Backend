-- Booking-to-payment-to-review workflow (additive).
--
--   1. booking."arrivedAt"   the professional's own report that they arrived (not a verified location)
--   2. chat_message          private, booking-linked, append-only conversation
--   3. data fix              a booking that already has a verified payment but is still COMPLETION_PENDING
--                            is completed (payment now completes bookings; it did not before)
--
-- No existing column, status value or constraint is changed or dropped. The booking status enum is
-- unchanged on purpose: COMPLETION_PENDING now means "work finished, payment due" and COMPLETED means
-- "completed after a verified payment" (see docs/BOOKINGS.md).

-- 1. Arrival -----------------------------------------------------------------------------------------
ALTER TABLE "booking" ADD COLUMN "arrivedAt" TIMESTAMP(3);

-- An arrival can only be reported for a booking that was confirmed first.
ALTER TABLE "booking" ADD CONSTRAINT "booking_arrived_after_confirmed"
  CHECK ("arrivedAt" IS NULL OR "confirmedAt" IS NOT NULL);

-- 2. Chat --------------------------------------------------------------------------------------------
CREATE TABLE "chat_message" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" "ActorRole" NOT NULL,
    "body" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_message_seq_key" ON "chat_message"("seq");
-- Resending the same message (network retry, double click) can never create a second row.
CREATE UNIQUE INDEX "chat_message_bookingId_senderId_clientMessageId_key" ON "chat_message"("bookingId", "senderId", "clientMessageId");
CREATE INDEX "chat_message_bookingId_seq_idx" ON "chat_message"("bookingId", "seq");

ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_sender_role" CHECK ("senderRole" IN ('CUSTOMER', 'WORKER'));
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_client_id_shape" CHECK ("clientMessageId" ~ '^[A-Za-z0-9_-]{8,64}$');

-- Whoever writes to this table (the API, a script, a future service), a message must come from the booking's
-- own customer or its assigned professional, in the matching role, on a booking that was confirmed.
CREATE FUNCTION "chat_message_guard"() RETURNS trigger AS $$
DECLARE
  b_customer TEXT;
  b_worker TEXT;
  b_confirmed TIMESTAMP;
BEGIN
  SELECT b."customerId", wp."userId", b."confirmedAt"
    INTO b_customer, b_worker, b_confirmed
    FROM "booking" b JOIN "worker_profile" wp ON wp."id" = b."workerProfileId"
   WHERE b."id" = NEW."bookingId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_message: unknown booking' USING ERRCODE = '23503';
  END IF;
  IF NOT ((NEW."senderRole" = 'CUSTOMER' AND NEW."senderId" = b_customer)
       OR (NEW."senderRole" = 'WORKER' AND NEW."senderId" = b_worker)) THEN
    RAISE EXCEPTION 'chat_message: the sender is not a participant of this booking in that role' USING ERRCODE = '23514';
  END IF;
  IF b_confirmed IS NULL THEN
    RAISE EXCEPTION 'chat_message: a booking has no conversation before the professional accepts it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_message_participants"
  BEFORE INSERT ON "chat_message"
  FOR EACH ROW EXECUTE FUNCTION "chat_message_guard"();

-- Append-only: nobody (including a participant or an administrator) can edit or delete a message, so the
-- record a dispute relies on cannot be tampered with.
CREATE FUNCTION "chat_message_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chat_message is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_message_no_update_delete"
  BEFORE UPDATE OR DELETE ON "chat_message"
  FOR EACH ROW EXECUTE FUNCTION "chat_message_append_only"();

-- 3. Data fix ----------------------------------------------------------------------------------------
-- Before this change a customer's own "confirm" completed a booking and payment never did. A booking that is
-- still awaiting that confirmation but already has a verified payment is completed now, with a history line.
WITH paid AS (
  SELECT DISTINCT ON (p."bookingId") p."bookingId", p."succeededAt"
    FROM "payment" p
   WHERE p."status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
     AND p."succeededAt" IS NOT NULL
     AND (p."reviewReason" IS NULL OR p."reviewReason" <> 'DUPLICATE_PAYMENT')
   ORDER BY p."bookingId", p."succeededAt"
), moved AS (
  UPDATE "booking" b
     SET "status" = 'COMPLETED', "completedAt" = COALESCE(b."completedAt", paid."succeededAt")
    FROM paid
   WHERE b."id" = paid."bookingId" AND b."status" = 'COMPLETION_PENDING'
  RETURNING b."id"
)
INSERT INTO "booking_event" ("id", "bookingId", "actorRole", "type", "fromStatus", "toStatus", "metadata")
SELECT gen_random_uuid()::text, moved."id", 'SYSTEM', 'booking.completed', 'COMPLETION_PENDING', 'COMPLETED',
       '{"source": "migration", "reason": "verified payment already recorded"}'::jsonb
  FROM moved;
