ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "activationTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "activationExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activationSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);

UPDATE "User"
   SET "status" = 'ACTIVE'
 WHERE "status" IS NULL;

CREATE INDEX IF NOT EXISTS "User_activationTokenHash_idx"
  ON "User"("activationTokenHash");
