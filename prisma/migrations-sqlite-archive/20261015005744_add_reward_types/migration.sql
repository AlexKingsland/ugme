-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "moment" TEXT NOT NULL,
    "productId" TEXT,
    "productTitle" TEXT,
    "productImageUrl" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'VIDEO',
    "captureSpecs" TEXT NOT NULL DEFAULT '[]',
    "rewardType" TEXT NOT NULL DEFAULT 'DISCOUNT_CODE',
    "rewardCycles" INTEGER NOT NULL DEFAULT 1,
    "rewardFrequency" TEXT NOT NULL DEFAULT 'MONTH',
    "discountType" TEXT NOT NULL DEFAULT 'FREE',
    "discountValue" REAL NOT NULL DEFAULT 0,
    "discountCodeAmount" REAL,
    "discountCodeType" TEXT,
    "discountCodeExpiryDays" INTEGER,
    "discountCodeMinOrder" REAL,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "maxSubmissions" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Campaign" ("captureSpecs", "contentType", "createdAt", "discountType", "discountValue", "endDate", "id", "maxSubmissions", "moment", "productId", "productImageUrl", "productTitle", "rewardCycles", "rewardFrequency", "shopId", "startDate", "status", "title", "updatedAt") SELECT "captureSpecs", "contentType", "createdAt", "discountType", "discountValue", "endDate", "id", "maxSubmissions", "moment", "productId", "productImageUrl", "productTitle", "rewardCycles", "rewardFrequency", "shopId", "startDate", "status", "title", "updatedAt" FROM "Campaign";
DROP TABLE "Campaign";
ALTER TABLE "new_Campaign" RENAME TO "Campaign";
CREATE INDEX "Campaign_shopId_idx" ON "Campaign"("shopId");
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
CREATE TABLE "new_Reward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rewardType" TEXT NOT NULL DEFAULT 'DISCOUNT_CODE',
    "cycles" INTEGER NOT NULL DEFAULT 1,
    "discountProvider" TEXT,
    "externalDiscountId" TEXT,
    "rechargeChargeId" TEXT,
    "rechargeSubscriptionId" TEXT,
    "discountCode" TEXT,
    "appliedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reward_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reward_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Reward" ("appliedAt", "createdAt", "customerId", "cycles", "discountCode", "discountProvider", "externalDiscountId", "id", "rechargeChargeId", "rechargeSubscriptionId", "status", "submissionId", "updatedAt") SELECT "appliedAt", "createdAt", "customerId", "cycles", "discountCode", "discountProvider", "externalDiscountId", "id", "rechargeChargeId", "rechargeSubscriptionId", "status", "submissionId", "updatedAt" FROM "Reward";
DROP TABLE "Reward";
ALTER TABLE "new_Reward" RENAME TO "Reward";
CREATE UNIQUE INDEX "Reward_submissionId_key" ON "Reward"("submissionId");
CREATE INDEX "Reward_customerId_idx" ON "Reward"("customerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
