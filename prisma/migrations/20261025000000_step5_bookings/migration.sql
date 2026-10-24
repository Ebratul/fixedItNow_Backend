-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'QUOTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETION_PENDING', 'COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RescheduleStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('CUSTOMER', 'WORKER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'WAITING_FOR_INFORMATION', 'RESOLVED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "DisputeCategory" AS ENUM ('SERVICE_QUALITY', 'NO_SHOW', 'PRICE_DISAGREEMENT', 'CONDUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeOutcome" AS ENUM ('MARK_COMPLETED', 'CANCEL_BOOKING', 'RESTORE_BOOKING');

-- CreateTable
CREATE TABLE "worker_availability_rule" (
    "id" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_availability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_time_off" (
    "id" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "description" TEXT NOT NULL,
    "serviceArea" TEXT NOT NULL,
    "serviceAddress" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "pricingModel" "PricingModel" NOT NULL,
    "unitPriceBdt" INTEGER,
    "pricingSnapshot" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "agreedAmountBdt" INTEGER,
    "acceptedQuoteId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completionRequestedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_event" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" "ActorRole" NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus",
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'PENDING',
    "laborBdt" INTEGER NOT NULL,
    "materialsBdt" INTEGER NOT NULL DEFAULT 0,
    "otherBdt" INTEGER NOT NULL DEFAULT 0,
    "totalBdt" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "description" TEXT NOT NULL,
    "terms" TEXT,
    "estimatedDurationMinutes" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_request" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedByRole" "ActorRole" NOT NULL,
    "previousStartAt" TIMESTAMP(3) NOT NULL,
    "previousEndAt" TIMESTAMP(3) NOT NULL,
    "newStartAt" TIMESTAMP(3) NOT NULL,
    "newEndAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" "RescheduleStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reschedule_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "openedByRole" "ActorRole" NOT NULL,
    "category" "DisputeCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "previousBookingStatus" "BookingStatus" NOT NULL,
    "assignedAdminId" TEXT,
    "outcome" "DisputeOutcome",
    "resolution" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_message" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorRole" "ActorRole" NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_availability_rule_workerProfileId_weekday_idx" ON "worker_availability_rule"("workerProfileId", "weekday");

-- CreateIndex
CREATE INDEX "worker_time_off_workerProfileId_startAt_idx" ON "worker_time_off"("workerProfileId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "booking_acceptedQuoteId_key" ON "booking"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "booking_customerId_createdAt_idx" ON "booking"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "booking_workerProfileId_status_startAt_idx" ON "booking"("workerProfileId", "status", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "booking_customerId_idempotencyKey_key" ON "booking"("customerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "booking_event_bookingId_createdAt_idx" ON "booking_event"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "quote_bookingId_createdAt_idx" ON "quote"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "reschedule_request_bookingId_createdAt_idx" ON "reschedule_request"("bookingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_bookingId_key" ON "dispute"("bookingId");

-- CreateIndex
CREATE INDEX "dispute_status_createdAt_idx" ON "dispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "dispute_message_disputeId_createdAt_idx" ON "dispute_message"("disputeId", "createdAt");

-- AddForeignKey
ALTER TABLE "worker_availability_rule" ADD CONSTRAINT "worker_availability_rule_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_time_off" ADD CONSTRAINT "worker_time_off_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "service_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_event" ADD CONSTRAINT "booking_event_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_request" ADD CONSTRAINT "reschedule_request_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_message" ADD CONSTRAINT "dispute_message_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written constraints that Prisma cannot model (reviewed with the rest of
-- this migration). They protect business invariants at the database level, so
-- they hold even if application code has a bug or two requests race.
-- ===========================================================================

-- Needed for "workerProfileId WITH =" inside a GiST exclusion constraint.
-- btree_gist is a trusted extension (PostgreSQL 13+): the database owner may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A worker cannot have two overlapping appointments that RESERVE the slot.
-- Half-open ranges [startAt, endAt): 10:00-11:00 and 11:00-12:00 do not overlap.
-- REQUESTED / QUOTED bookings deliberately do not reserve a slot.
ALTER TABLE "booking"
  ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "workerProfileId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETION_PENDING'));

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_time_order" CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "booking_duration_positive" CHECK ("durationMinutes" > 0),
  ADD CONSTRAINT "booking_amount_nonnegative" CHECK ("agreedAmountBdt" IS NULL OR "agreedAmountBdt" >= 0);

-- At most one open quote / one open reschedule request per booking.
CREATE UNIQUE INDEX "quote_one_pending_per_booking" ON "quote" ("bookingId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "reschedule_one_pending_per_booking" ON "reschedule_request" ("bookingId") WHERE "status" = 'PENDING';

ALTER TABLE "quote"
  ADD CONSTRAINT "quote_amounts_valid" CHECK (
    "laborBdt" >= 0 AND "materialsBdt" >= 0 AND "otherBdt" >= 0
    AND "totalBdt" > 0
    AND "totalBdt" = "laborBdt" + "materialsBdt" + "otherBdt"
  );

ALTER TABLE "reschedule_request"
  ADD CONSTRAINT "reschedule_time_order" CHECK ("newEndAt" > "newStartAt");

ALTER TABLE "worker_availability_rule"
  ADD CONSTRAINT "availability_rule_bounds" CHECK (
    "weekday" BETWEEN 0 AND 6 AND "startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"
  );

ALTER TABLE "worker_time_off"
  ADD CONSTRAINT "time_off_order" CHECK ("endAt" > "startAt");
