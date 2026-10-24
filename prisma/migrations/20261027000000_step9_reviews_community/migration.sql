-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('LIKE');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'DECLINED', 'PLANNED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('POST', 'COMMENT', 'REVIEW', 'PROPOSAL');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'ABUSE', 'FRAUD', 'INAPPROPRIATE', 'PRIVACY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED');

-- CreateTable
CREATE TABLE "review" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_revision" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_reaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_proposal" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'SUBMITTED',
    "responseNote" TEXT,
    "respondedById" TEXT,
    "respondedAt" TIMESTAMP(3),
    "visibility" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderatedById" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_vote" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "reviewId" TEXT,
    "proposalId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "decisionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_bookingId_key" ON "review"("bookingId");

-- CreateIndex
CREATE INDEX "review_workerProfileId_status_createdAt_idx" ON "review"("workerProfileId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "review_customerId_createdAt_idx" ON "review"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "review_revision_reviewId_createdAt_idx" ON "review_revision"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "community_post_status_createdAt_id_idx" ON "community_post"("status", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "community_post_authorId_createdAt_idx" ON "community_post"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "post_comment_postId_status_createdAt_id_idx" ON "post_comment"("postId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "post_comment_authorId_createdAt_idx" ON "post_comment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "post_reaction_userId_idx" ON "post_reaction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "post_reaction_postId_userId_type_key" ON "post_reaction"("postId", "userId", "type");

-- CreateIndex
CREATE INDEX "feature_proposal_visibility_status_createdAt_id_idx" ON "feature_proposal"("visibility", "status", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "feature_proposal_authorId_createdAt_idx" ON "feature_proposal"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "feature_vote_userId_idx" ON "feature_vote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "feature_vote_proposalId_userId_key" ON "feature_vote"("proposalId", "userId");

-- CreateIndex
CREATE INDEX "content_report_status_createdAt_id_idx" ON "content_report"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "content_report_targetType_status_idx" ON "content_report"("targetType", "status");

-- CreateIndex
CREATE INDEX "content_report_postId_idx" ON "content_report"("postId");

-- CreateIndex
CREATE INDEX "content_report_commentId_idx" ON "content_report"("commentId");

-- CreateIndex
CREATE INDEX "content_report_reviewId_idx" ON "content_report"("reviewId");

-- CreateIndex
CREATE INDEX "content_report_proposalId_idx" ON "content_report"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "content_report_reporterId_targetKey_key" ON "content_report"("reporterId", "targetKey");

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "worker_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_revision" ADD CONSTRAINT "review_revision_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "community_post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_reaction" ADD CONSTRAINT "post_reaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "community_post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_reaction" ADD CONSTRAINT "post_reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_proposal" ADD CONSTRAINT "feature_proposal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_proposal" ADD CONSTRAINT "feature_proposal_respondedById_fkey" FOREIGN KEY ("respondedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_proposal" ADD CONSTRAINT "feature_proposal_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_vote" ADD CONSTRAINT "feature_vote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "feature_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_vote" ADD CONSTRAINT "feature_vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_postId_fkey" FOREIGN KEY ("postId") REFERENCES "community_post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "post_comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "feature_proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot model. The API validates the same rules; these make
-- them hold even if application code is wrong.
-- ---------------------------------------------------------------------------

-- Reviews: rating 1-5, bounded text, and a moderation reason whenever hidden.
ALTER TABLE "review"
  ADD CONSTRAINT "review_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "review_comment_length" CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "review_hidden_has_reason" CHECK ("status" <> 'HIDDEN' OR "moderationReason" IS NOT NULL);
ALTER TABLE "review_revision"
  ADD CONSTRAINT "review_revision_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- Community content: bounded text; hidden content always carries a reason.
ALTER TABLE "community_post"
  ADD CONSTRAINT "community_post_title_length" CHECK (char_length("title") BETWEEN 3 AND 120),
  ADD CONSTRAINT "community_post_body_length" CHECK (char_length("body") BETWEEN 1 AND 5000),
  ADD CONSTRAINT "community_post_hidden_has_reason" CHECK ("status" <> 'HIDDEN' OR "moderationReason" IS NOT NULL);
ALTER TABLE "post_comment"
  ADD CONSTRAINT "post_comment_body_length" CHECK (char_length("body") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "post_comment_hidden_has_reason" CHECK ("status" <> 'HIDDEN' OR "moderationReason" IS NOT NULL);
ALTER TABLE "feature_proposal"
  ADD CONSTRAINT "feature_proposal_title_length" CHECK (char_length("title") BETWEEN 5 AND 120),
  ADD CONSTRAINT "feature_proposal_description_length" CHECK (char_length("description") BETWEEN 10 AND 2000),
  ADD CONSTRAINT "feature_proposal_response_length" CHECK ("responseNote" IS NULL OR char_length("responseNote") <= 1000),
  ADD CONSTRAINT "feature_proposal_hidden_has_reason" CHECK ("visibility" <> 'HIDDEN' OR "moderationReason" IS NOT NULL),
  ADD CONSTRAINT "feature_proposal_declined_has_response" CHECK ("status" <> 'DECLINED' OR "responseNote" IS NOT NULL);

-- A report points at exactly ONE record, and it is the kind that targetType names.
ALTER TABLE "content_report"
  ADD CONSTRAINT "content_report_one_target" CHECK (
    ("targetType" = 'POST'     AND "postId"     IS NOT NULL AND "commentId" IS NULL AND "reviewId" IS NULL AND "proposalId" IS NULL) OR
    ("targetType" = 'COMMENT'  AND "commentId"  IS NOT NULL AND "postId" IS NULL AND "reviewId" IS NULL AND "proposalId" IS NULL) OR
    ("targetType" = 'REVIEW'   AND "reviewId"   IS NOT NULL AND "postId" IS NULL AND "commentId" IS NULL AND "proposalId" IS NULL) OR
    ("targetType" = 'PROPOSAL' AND "proposalId" IS NOT NULL AND "postId" IS NULL AND "commentId" IS NULL AND "reviewId" IS NULL)
  ),
  ADD CONSTRAINT "content_report_details_length" CHECK ("details" IS NULL OR char_length("details") <= 500),
  ADD CONSTRAINT "content_report_resolved_coherent" CHECK (("status" IN ('ACTIONED', 'DISMISSED')) = ("resolvedAt" IS NOT NULL));
