-- When the merchant accepted the usage rights agreement for a wall campaign
ALTER TABLE "Campaign" ADD COLUMN "rightsAcknowledgedAt" DATETIME;
-- Campaigns created with the old flow accepted them in its "Rights" step
UPDATE "Campaign" SET "rightsAcknowledgedAt" = "createdAt" WHERE "status" <> 'DRAFT';
