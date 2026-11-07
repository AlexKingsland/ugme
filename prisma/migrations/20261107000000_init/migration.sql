-- Postgres baseline (2026-11-07). Earlier SQLite history: prisma/migrations-sqlite-archive/

-- CreateEnum
CREATE TYPE "SubscriptionProvider" AS ENUM ('RECHARGE', 'SHOPIFY_NATIVE');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PHOTO', 'VIDEO', 'ANY');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('FREE', 'FIXED_AMOUNT', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('NONE', 'DISCOUNT_CODE', 'STORE_CREDIT', 'SUBSCRIPTION_DISCOUNT');

-- CreateEnum
CREATE TYPE "BillingFrequency" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "StorageTier" AS ENUM ('TIER_10GB', 'TIER_100GB', 'TIER_1TB');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('CREATED', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('MAGIC_LINK', 'SUBMISSION_RECEIVED', 'SUBMISSION_APPROVED', 'SUBMISSION_REJECTED', 'CAMPAIGN_INVITE');

-- CreateEnum
CREATE TYPE "AttributionKind" AS ENUM ('DIRECT', 'INFLUENCED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "subscriptionProvider" "SubscriptionProvider" NOT NULL DEFAULT 'SHOPIFY_NATIVE',
    "providerApiKey" TEXT,
    "providerConnected" BOOLEAN NOT NULL DEFAULT false,
    "providerConfig" TEXT NOT NULL DEFAULT '{}',
    "defaultRewardCycles" INTEGER NOT NULL DEFAULT 1,
    "storageTier" "StorageTier" NOT NULL DEFAULT 'TIER_10GB',
    "planTier" "PlanTier" NOT NULL DEFAULT 'FREE',
    "shopifySubscriptionId" TEXT,
    "planActivatedAt" TIMESTAMP(3),
    "brandName" TEXT,
    "logoUrl" TEXT,
    "pixelActivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "moment" TEXT NOT NULL,
    "productId" TEXT,
    "productTitle" TEXT,
    "productImageUrl" TEXT,
    "productScope" TEXT NOT NULL DEFAULT 'SPECIFIC',
    "products" TEXT NOT NULL DEFAULT '[]',
    "contentType" "ContentType" NOT NULL DEFAULT 'VIDEO',
    "captureSpecs" TEXT NOT NULL DEFAULT '[]',
    "rewardType" "RewardType" NOT NULL DEFAULT 'DISCOUNT_CODE',
    "rewardCycles" INTEGER NOT NULL DEFAULT 1,
    "rewardFrequency" "BillingFrequency" NOT NULL DEFAULT 'MONTH',
    "discountType" "DiscountType" NOT NULL DEFAULT 'FREE',
    "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountCodeAmount" DOUBLE PRECISION,
    "discountCodeType" TEXT,
    "discountCodeExpiryDays" INTEGER,
    "discountCodeMinOrder" DOUBLE PRECISION,
    "storeCreditAmount" DOUBLE PRECISION,
    "storeCreditExpiryDays" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "maxSubmissions" INTEGER,
    "rightsAcknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "subscriptionId" TEXT,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "magicLinkToken" TEXT,
    "magicLinkExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "contentType" "ContentType" NOT NULL DEFAULT 'PHOTO',
    "contentUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "durationSecs" INTEGER,
    "description" TEXT,
    "subscriptionId" TEXT,
    "products" TEXT NOT NULL DEFAULT '[]',
    "displayName" TEXT,
    "markedUsed" BOOLEAN NOT NULL DEFAULT false,
    "usageTags" TEXT NOT NULL DEFAULT '[]',
    "rightsAccepted" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rewardType" "RewardType" NOT NULL DEFAULT 'DISCOUNT_CODE',
    "cycles" INTEGER NOT NULL DEFAULT 1,
    "discountProvider" TEXT,
    "externalDiscountId" TEXT,
    "rechargeChargeId" TEXT,
    "rechargeSubscriptionId" TEXT,
    "discountCode" TEXT,
    "storeCreditAmount" DOUBLE PRECISION,
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "RewardStatus" NOT NULL DEFAULT 'CREATED',
    "failureReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeCustomer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "rechargeCustomerId" TEXT NOT NULL,
    "rechargeSubscriptionId" TEXT,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextChargeDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "day" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "counted" BOOLEAN NOT NULL DEFAULT true,
    "linesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WallOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallOrderLine" (
    "id" TEXT NOT NULL,
    "orderRefId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "kind" "AttributionKind" NOT NULL,
    "campaignId" TEXT,
    "submissionId" TEXT,
    "quantity" INTEGER NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WallOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallDailyStat" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "directCents" INTEGER NOT NULL DEFAULT 0,
    "influencedCents" INTEGER NOT NULL DEFAULT 0,
    "directOrders" INTEGER NOT NULL DEFAULT 0,
    "influencedOrders" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WallDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallPostDailyStat" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "campaignId" TEXT,
    "directCents" INTEGER NOT NULL DEFAULT 0,
    "influencedCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WallPostDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallPixelView" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seen" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WallPixelView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WallRefund" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WallRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Campaign_shopId_idx" ON "Campaign"("shopId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Customer_shopId_idx" ON "Customer"("shopId");

-- CreateIndex
CREATE INDEX "Customer_magicLinkToken_idx" ON "Customer"("magicLinkToken");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopId_email_key" ON "Customer"("shopId", "email");

-- CreateIndex
CREATE INDEX "Submission_campaignId_idx" ON "Submission"("campaignId");

-- CreateIndex
CREATE INDEX "Submission_customerId_idx" ON "Submission"("customerId");

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Reward_submissionId_key" ON "Reward"("submissionId");

-- CreateIndex
CREATE INDEX "Reward_customerId_idx" ON "Reward"("customerId");

-- CreateIndex
CREATE INDEX "RechargeCustomer_shopId_idx" ON "RechargeCustomer"("shopId");

-- CreateIndex
CREATE INDEX "RechargeCustomer_rechargeCustomerId_idx" ON "RechargeCustomer"("rechargeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCustomer_shopId_shopifyCustomerId_key" ON "RechargeCustomer"("shopId", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "EmailLog_customerId_idx" ON "EmailLog"("customerId");

-- CreateIndex
CREATE INDEX "WallOrder_shopId_orderedAt_idx" ON "WallOrder"("shopId", "orderedAt");

-- CreateIndex
CREATE INDEX "WallOrder_orderedAt_idx" ON "WallOrder"("orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WallOrder_shopId_orderId_key" ON "WallOrder"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "WallOrderLine_campaignId_idx" ON "WallOrderLine"("campaignId");

-- CreateIndex
CREATE INDEX "WallOrderLine_submissionId_idx" ON "WallOrderLine"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "WallOrderLine_orderRefId_lineItemId_key" ON "WallOrderLine"("orderRefId", "lineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WallDailyStat_shopId_day_key" ON "WallDailyStat"("shopId", "day");

-- CreateIndex
CREATE INDEX "WallPostDailyStat_shopId_day_idx" ON "WallPostDailyStat"("shopId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "WallPostDailyStat_shopId_day_submissionId_key" ON "WallPostDailyStat"("shopId", "day", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "WallPixelView_shopId_orderId_key" ON "WallPixelView"("shopId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WallRefund_shopId_refundId_key" ON "WallRefund"("shopId", "refundId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCustomer" ADD CONSTRAINT "RechargeCustomer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WallOrderLine" ADD CONSTRAINT "WallOrderLine_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "WallOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

