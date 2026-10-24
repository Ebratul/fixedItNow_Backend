-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('BKASH', 'SSLCOMMERZ');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'INITIATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REQUIRES_REVIEW', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentReviewReason" AS ENUM ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'REFERENCE_MISMATCH', 'DUPLICATE_PAYMENT', 'PROVIDER_RISK_FLAG', 'BOOKING_INELIGIBLE');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountBdt" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "refundedAmountBdt" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "providerPaymentId" TEXT,
    "providerTransactionId" TEXT,
    "providerValidationId" TEXT,
    "checkoutUrl" TEXT,
    "failureCode" TEXT,
    "reviewReason" "PaymentReviewReason",
    "initiatedAt" TIMESTAMP(3),
    "callbackReceivedAt" TIMESTAMP(3),
    "executeStartedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_event" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "refundId" TEXT,
    "type" TEXT NOT NULL,
    "fromStatus" "PaymentStatus",
    "toStatus" "PaymentStatus",
    "actorUserId" TEXT,
    "actorRole" "ActorRole" NOT NULL,
    "dedupeKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedByRole" "ActorRole" NOT NULL,
    "requestedAmountBdt" INTEGER NOT NULL,
    "approvedAmountBdt" INTEGER,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "providerRefundReference" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "failureCode" TEXT,
    "processStartedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_reference_key" ON "payment"("reference");

-- CreateIndex
CREATE INDEX "payment_bookingId_createdAt_idx" ON "payment"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_customerId_createdAt_idx" ON "payment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_status_createdAt_idx" ON "payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_customerId_idempotencyKey_key" ON "payment"("customerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_providerPaymentId_key" ON "payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_providerTransactionId_key" ON "payment"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_event_dedupeKey_key" ON "payment_event"("dedupeKey");

-- CreateIndex
CREATE INDEX "payment_event_paymentId_createdAt_idx" ON "payment_event"("paymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refund_providerRefundReference_key" ON "refund"("providerRefundReference");

-- CreateIndex
CREATE INDEX "refund_paymentId_createdAt_idx" ON "refund"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "refund_status_createdAt_idx" ON "refund"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requestedByUserId_idempotencyKey_key" ON "refund"("requestedByUserId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express. See docs/PAYMENTS.md.
-- ---------------------------------------------------------------------------

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_amount_positive" CHECK ("amountBdt" > 0),
  ADD CONSTRAINT "payment_currency_bdt" CHECK ("currency" = 'BDT'),
  ADD CONSTRAINT "payment_refunded_bounds" CHECK ("refundedAmountBdt" >= 0 AND "refundedAmountBdt" <= "amountBdt"),
  ADD CONSTRAINT "payment_success_has_provider_txn" CHECK (
    "status" NOT IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED') OR "providerTransactionId" IS NOT NULL
  ),
  ADD CONSTRAINT "payment_refund_status_consistent" CHECK (
    ("status" <> 'REFUNDED' OR "refundedAmountBdt" = "amountBdt")
    AND ("status" <> 'PARTIALLY_REFUNDED' OR ("refundedAmountBdt" > 0 AND "refundedAmountBdt" < "amountBdt"))
  );

-- At most ONE paid obligation per booking: a second verified payment cannot
-- become SUCCEEDED; it is parked as REQUIRES_REVIEW (outside this index). A parked
-- duplicate keeps reviewReason = DUPLICATE_PAYMENT for good, so it stays outside
-- the index even after it is refunded (REFUNDED), which is how it gets resolved.
CREATE UNIQUE INDEX "payment_one_paid_per_booking" ON "payment" ("bookingId")
  WHERE "status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
    AND "reviewReason" IS DISTINCT FROM 'DUPLICATE_PAYMENT';

-- At most ONE open attempt per booking (double-click / parallel tabs / retries).
CREATE UNIQUE INDEX "payment_one_open_per_booking" ON "payment" ("bookingId")
  WHERE "status" IN ('PENDING', 'INITIATED', 'PROCESSING');

ALTER TABLE "refund"
  ADD CONSTRAINT "refund_requested_positive" CHECK ("requestedAmountBdt" > 0),
  ADD CONSTRAINT "refund_approved_bounds" CHECK (
    "approvedAmountBdt" IS NULL OR ("approvedAmountBdt" > 0 AND "approvedAmountBdt" <= "requestedAmountBdt")
  ),
  ADD CONSTRAINT "refund_approved_when_needed" CHECK (
    "status" NOT IN ('APPROVED', 'PROCESSING', 'SUCCEEDED') OR "approvedAmountBdt" IS NOT NULL
  );

-- At most ONE open refund per payment: concurrent requests/approvals cannot
-- allocate the same remaining balance twice.
CREATE UNIQUE INDEX "refund_one_open_per_payment" ON "refund" ("paymentId")
  WHERE "status" IN ('REQUESTED', 'APPROVED', 'PROCESSING');

-- payment_event is append-only: history can be added to, never rewritten.
CREATE FUNCTION "payment_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_event is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "payment_event"
  FOR EACH ROW EXECUTE FUNCTION "payment_event_append_only"();
