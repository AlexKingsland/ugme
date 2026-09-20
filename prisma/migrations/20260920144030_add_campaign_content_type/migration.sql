-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "moment" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'VIDEO',
    "captureSpecs" TEXT NOT NULL DEFAULT '[]',
    "rewardMonths" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "maxSubmissions" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Campaign" ("captureSpecs", "createdAt", "endDate", "id", "maxSubmissions", "moment", "rewardMonths", "shopId", "startDate", "status", "title", "updatedAt") SELECT "captureSpecs", "createdAt", "endDate", "id", "maxSubmissions", "moment", "rewardMonths", "shopId", "startDate", "status", "title", "updatedAt" FROM "Campaign";
DROP TABLE "Campaign";
ALTER TABLE "new_Campaign" RENAME TO "Campaign";
CREATE INDEX "Campaign_shopId_idx" ON "Campaign"("shopId");
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
