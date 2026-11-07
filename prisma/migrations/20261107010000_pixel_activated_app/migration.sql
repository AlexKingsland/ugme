-- Which app turned the checkout pixel on (production and the dev app each have their own)
ALTER TABLE "Shop" ADD COLUMN "pixelActivatedApp" TEXT;
