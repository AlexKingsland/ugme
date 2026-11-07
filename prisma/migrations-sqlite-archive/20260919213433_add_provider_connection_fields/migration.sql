-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "subscriptionProvider" TEXT NOT NULL DEFAULT 'SHOPIFY_NATIVE',
    "providerApiKey" TEXT,
    "providerConnected" BOOLEAN NOT NULL DEFAULT false,
    "providerConfig" TEXT NOT NULL DEFAULT '{}',
    "defaultRewardMonths" INTEGER NOT NULL DEFAULT 1,
    "brandName" TEXT,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Shop" ("accessToken", "brandName", "createdAt", "defaultRewardMonths", "id", "logoUrl", "providerConfig", "shopDomain", "subscriptionProvider", "updatedAt") SELECT "accessToken", "brandName", "createdAt", "defaultRewardMonths", "id", "logoUrl", "providerConfig", "shopDomain", "subscriptionProvider", "updatedAt" FROM "Shop";
DROP TABLE "Shop";
ALTER TABLE "new_Shop" RENAME TO "Shop";
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
