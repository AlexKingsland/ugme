-- Social Wall pivot: campaigns become "wall campaigns"
ALTER TABLE "Campaign" ADD COLUMN "productScope" TEXT NOT NULL DEFAULT 'SPECIFIC';
ALTER TABLE "Campaign" ADD COLUMN "products" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Campaign" ADD COLUMN "storeCreditAmount" REAL;
ALTER TABLE "Campaign" ADD COLUMN "storeCreditExpiryDays" INTEGER;
ALTER TABLE "Submission" ADD COLUMN "productIds" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Submission" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Reward" ADD COLUMN "storeCreditAmount" REAL;

-- Existing campaigns: carry their single product over to the products list
UPDATE "Campaign"
SET "products" = json_array(json_object(
  'id', "productId",
  'title', COALESCE("productTitle", ''),
  'handle', NULL,
  'imageUrl', "productImageUrl"
))
WHERE "productId" IS NOT NULL AND "productId" <> '';

UPDATE "Campaign" SET "productScope" = 'ALL' WHERE "productId" IS NULL OR "productId" = '';

-- Existing submissions on single-product campaigns link to that product
UPDATE "Submission"
SET "productIds" = (SELECT json_array(c."productId") FROM "Campaign" c WHERE c."id" = "Submission"."campaignId")
WHERE EXISTS (SELECT 1 FROM "Campaign" c WHERE c."id" = "Submission"."campaignId" AND c."productId" IS NOT NULL AND c."productId" <> '');

-- Subscription rewards are no longer offered: pause those campaigns
UPDATE "Campaign" SET "status" = 'PAUSED' WHERE "rewardType" = 'SUBSCRIPTION_DISCOUNT' AND "status" = 'ACTIVE';
