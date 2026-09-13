ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "resetTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "resetExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resetRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_resetTokenHash_idx"
  ON "User"("resetTokenHash");

CREATE TABLE IF NOT EXISTS "AuthAudit" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER,
  "email" TEXT,
  "event" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'info',
  "ip" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuthAudit_createdAt_idx" ON "AuthAudit"("createdAt");
CREATE INDEX IF NOT EXISTS "AuthAudit_userId_idx" ON "AuthAudit"("userId");
CREATE INDEX IF NOT EXISTS "AuthAudit_event_idx" ON "AuthAudit"("event");

ALTER TABLE IF EXISTS "AuthAudit"
  ADD CONSTRAINT "AuthAudit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
