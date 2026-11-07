-- Reward fulfilment tracking (failure reason, attempts, code expiry)
ALTER TABLE "Reward" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "Reward" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "Reward" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Reward" ADD COLUMN "lastAttemptAt" DATETIME;

-- Data fix: approval never set Reward.rewardType, so every row defaulted to
-- DISCOUNT_CODE. Copy the real type from the submission's campaign.
UPDATE "Reward"
SET "rewardType" = (
  SELECT c."rewardType"
  FROM "Submission" s
  JOIN "Campaign" c ON c."id" = s."campaignId"
  WHERE s."id" = "Reward"."submissionId"
)
WHERE EXISTS (SELECT 1 FROM "Submission" s WHERE s."id" = "Reward"."submissionId");
