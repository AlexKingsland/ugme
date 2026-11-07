-- Dashboard rollups: reports read ≤ 1 row per day instead of scanning orders
ALTER TABLE "WallOrder" ADD COLUMN "day" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WallOrder" ADD COLUMN "counted" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "WallOrder_orderedAt_idx" ON "WallOrder"("orderedAt");

CREATE TABLE "WallDailyStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "directCents" INTEGER NOT NULL DEFAULT 0,
    "influencedCents" INTEGER NOT NULL DEFAULT 0,
    "directOrders" INTEGER NOT NULL DEFAULT 0,
    "influencedOrders" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "WallDailyStat_shopId_day_key" ON "WallDailyStat"("shopId", "day");

CREATE TABLE "WallPostDailyStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "campaignId" TEXT,
    "directCents" INTEGER NOT NULL DEFAULT 0,
    "influencedCents" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "WallPostDailyStat_shopId_day_submissionId_key" ON "WallPostDailyStat"("shopId", "day", "submissionId");
CREATE INDEX "WallPostDailyStat_shopId_day_idx" ON "WallPostDailyStat"("shopId", "day");
