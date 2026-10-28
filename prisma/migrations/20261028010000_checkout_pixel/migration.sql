-- Checkout web pixel: views for "Buy it now" checkouts + every order line for late credit
ALTER TABLE "WallOrder" ADD COLUMN "linesJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "WallPixelView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seen" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "WallPixelView_shopId_orderId_key" ON "WallPixelView"("shopId", "orderId");
