-- Store the purchased products' details (not just IDs) on each submission,
-- so the wall can show product cards without extra lookups.
ALTER TABLE "Submission" RENAME COLUMN "productIds" TO "products";
UPDATE "Submission"
SET "products" = (SELECT c."products" FROM "Campaign" c WHERE c."id" = "Submission"."campaignId")
WHERE "products" <> '[]';
