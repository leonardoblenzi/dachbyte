CREATE TABLE "ReleaseNote" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "newFeatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "adjustments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "htmlContent" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentByUserId" TEXT,

    CONSTRAINT "ReleaseNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReleaseNote_createdAt_idx" ON "ReleaseNote"("createdAt");

ALTER TABLE "ReleaseNote"
ADD CONSTRAINT "ReleaseNote_sentByUserId_fkey"
FOREIGN KEY ("sentByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
