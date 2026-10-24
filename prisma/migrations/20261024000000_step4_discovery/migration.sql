-- AlterTable
ALTER TABLE "worker_profile" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "startingPriceBdt" INTEGER,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT;

-- Backfill: starting price for profiles that already have priced services.
-- Additive and idempotent; leaves NULL where there is no priced service.
UPDATE "worker_profile" AS wp
SET "startingPriceBdt" = priced.min_price
FROM (
    SELECT "workerProfileId", MIN("basePriceBdt") AS min_price
    FROM "worker_service"
    WHERE "basePriceBdt" IS NOT NULL
    GROUP BY "workerProfileId"
) AS priced
WHERE priced."workerProfileId" = wp."id";

-- CreateTable
CREATE TABLE "favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_userId_createdAt_idx" ON "favorite"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_userId_workerProfileId_key" ON "favorite"("userId", "workerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "worker_profile_slug_key" ON "worker_profile"("slug");

-- CreateIndex
CREATE INDEX "worker_profile_publishedAt_idx" ON "worker_profile"("publishedAt");

-- CreateIndex
CREATE INDEX "worker_profile_startingPriceBdt_idx" ON "worker_profile"("startingPriceBdt");

-- CreateIndex
CREATE INDEX "worker_profile_experienceYears_idx" ON "worker_profile"("experienceYears");

-- CreateIndex
CREATE INDEX "worker_profile_serviceAreas_idx" ON "worker_profile" USING GIN ("serviceAreas");

-- CreateIndex
CREATE INDEX "worker_service_categoryId_idx" ON "worker_service"("categoryId");

-- AddForeignKey
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

