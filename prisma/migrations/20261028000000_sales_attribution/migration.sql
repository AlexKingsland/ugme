-- Sales attribution: every order (for % of revenue) + wall-driven lines
CREATE TABLE "WallOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "orderedAt" DATETIME NOT NULL,
    "currency" TEXT NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WallOrder_shopId_orderId_key" ON "WallOrder"("shopId", "orderId");
CREATE INDEX "WallOrder_shopId_orderedAt_idx" ON "WallOrder"("shopId", "orderedAt");

CREATE TABLE "WallOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderRefId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT,
    "submissionId" TEXT,
    "quantity" INTEGER NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "WallOrderLine_orderRefId_fkey" FOREIGN KEY ("orderRefId") REFERENCES "WallOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WallOrderLine_orderRefId_lineItemId_key" ON "WallOrderLine"("orderRefId", "lineItemId");
CREATE INDEX "WallOrderLine_campaignId_idx" ON "WallOrderLine"("campaignId");
CREATE INDEX "WallOrderLine_submissionId_idx" ON "WallOrderLine"("submissionId");

CREATE TABLE "WallRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "WallRefund_shopId_refundId_key" ON "WallRefund"("shopId", "refundId");
