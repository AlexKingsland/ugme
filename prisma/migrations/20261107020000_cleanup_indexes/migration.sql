-- Indexes for the periodic sales-data clean-up (delete by age)
CREATE INDEX "WallPixelView_createdAt_idx" ON "WallPixelView"("createdAt");
CREATE INDEX "WallRefund_createdAt_idx" ON "WallRefund"("createdAt");
