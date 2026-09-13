-- CreateTable
CREATE TABLE "UserAccessToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccessToken_tokenHash_key" ON "UserAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserAccessToken_userId_type_idx" ON "UserAccessToken"("userId", "type");

-- CreateIndex
CREATE INDEX "UserAccessToken_expiresAt_idx" ON "UserAccessToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserAccessToken"
ADD CONSTRAINT "UserAccessToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
