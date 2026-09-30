/*
  Warnings:

  - You are about to drop the column `rewardMonths` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `months` on the `Reward` table. All the data in the column will be lost.
  - You are about to drop the column `defaultRewardMonths` on the `Shop` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "RechargeCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "rechargeCustomerId" TEXT NOT NULL,
    "rechargeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextChargeDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RechargeCustomer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "rewardCycles" INTEGER NOT NULL DEFAULT 1,
    "rewardFrequency" TEXT NOT NULL DEFAULT 'MONTH',
    "discountType" TEXT NOT NULL DEFAULT 'FREE',
    "discountValue" REAL NOT NULL DEFAULT 0,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "maxSubmissions" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Campaign" ("captureSpecs", "contentType", "createdAt", "endDate", "id", "maxSubmissions", "moment", "shopId", "startDate", "status", "title", "updatedAt") SELECT "captureSpecs", "contentType", "createdAt", "endDate", "id", "maxSubmissions", "moment", "shopId", "startDate", "status", "title", "updatedAt" FROM "Campaign";
DROP TABLE "Campaign";
ALTER TABLE "new_Campaign" RENAME TO "Campaign";
CREATE INDEX "Campaign_shopId_idx" ON "Campaign"("shopId");
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
CREATE TABLE "new_Reward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "cycles" INTEGER NOT NULL DEFAULT 1,
    "discountProvider" TEXT NOT NULL,
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
INSERT INTO "new_Reward" ("appliedAt", "createdAt", "customerId", "discountProvider", "externalDiscountId", "id", "status", "submissionId", "updatedAt") SELECT "appliedAt", "createdAt", "customerId", "discountProvider", "externalDiscountId", "id", "status", "submissionId", "updatedAt" FROM "Reward";
DROP TABLE "Reward";
ALTER TABLE "new_Reward" RENAME TO "Reward";
CREATE UNIQUE INDEX "Reward_submissionId_key" ON "Reward"("submissionId");
CREATE INDEX "Reward_customerId_idx" ON "Reward"("customerId");
CREATE TABLE "new_Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "subscriptionProvider" TEXT NOT NULL DEFAULT 'SHOPIFY_NATIVE',
    "providerApiKey" TEXT,
    "providerConnected" BOOLEAN NOT NULL DEFAULT false,
    "providerConfig" TEXT NOT NULL DEFAULT '{}',
    "defaultRewardCycles" INTEGER NOT NULL DEFAULT 1,
    "storageTier" TEXT NOT NULL DEFAULT 'TIER_10GB',
    "planTier" TEXT NOT NULL DEFAULT 'FREE',
    "shopifySubscriptionId" TEXT,
    "planActivatedAt" DATETIME,
    "brandName" TEXT,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Shop" ("accessToken", "brandName", "createdAt", "id", "logoUrl", "providerApiKey", "providerConfig", "providerConnected", "shopDomain", "subscriptionProvider", "updatedAt") SELECT "accessToken", "brandName", "createdAt", "id", "logoUrl", "providerApiKey", "providerConfig", "providerConnected", "shopDomain", "subscriptionProvider", "updatedAt" FROM "Shop";
DROP TABLE "Shop";
ALTER TABLE "new_Shop" RENAME TO "Shop";
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
CREATE TABLE "new_Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contentType" TEXT NOT NULL DEFAULT 'PHOTO',
    "contentUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "durationSecs" INTEGER,
    "description" TEXT,
    "subscriptionId" TEXT,
    "markedUsed" BOOLEAN NOT NULL DEFAULT false,
    "usageTags" TEXT NOT NULL DEFAULT '[]',
    "rightsAccepted" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Submission_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Submission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Submission" ("campaignId", "contentType", "contentUrl", "createdAt", "customerId", "id", "reviewNote", "reviewedAt", "status", "thumbnailUrl", "updatedAt") SELECT "campaignId", "contentType", "contentUrl", "createdAt", "customerId", "id", "reviewNote", "reviewedAt", "status", "thumbnailUrl", "updatedAt" FROM "Submission";
DROP TABLE "Submission";
ALTER TABLE "new_Submission" RENAME TO "Submission";
CREATE INDEX "Submission_campaignId_idx" ON "Submission"("campaignId");
CREATE INDEX "Submission_customerId_idx" ON "Submission"("customerId");
CREATE INDEX "Submission_status_idx" ON "Submission"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "RechargeCustomer_shopId_idx" ON "RechargeCustomer"("shopId");

-- CreateIndex
CREATE INDEX "RechargeCustomer_rechargeCustomerId_idx" ON "RechargeCustomer"("rechargeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCustomer_shopId_shopifyCustomerId_key" ON "RechargeCustomer"("shopId", "shopifyCustomerId");
