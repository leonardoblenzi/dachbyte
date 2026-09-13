ALTER TABLE "OrderAddressChangeAlert"
ADD COLUMN "notificationAttemptedAt" TIMESTAMP(3),
ADD COLUMN "notificationSentAt" TIMESTAMP(3),
ADD COLUMN "notificationError" TEXT;

CREATE INDEX "OrderAddressChangeAlert_notificationSentAt_idx"
ON "OrderAddressChangeAlert"("notificationSentAt");
