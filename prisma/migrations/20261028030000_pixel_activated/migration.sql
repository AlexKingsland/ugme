-- When the app first turned on the checkout pixel (never re-enabled automatically after that)
ALTER TABLE "Shop" ADD COLUMN "pixelActivatedAt" DATETIME;
