CREATE TYPE "LogisyncRole" AS ENUM ('ADMIN_SUPER', 'ANALYST');

CREATE TABLE "LogisyncUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "role" "LogisyncRole" NOT NULL DEFAULT 'ANALYST',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LogisyncUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LogisyncUser_email_key" ON "LogisyncUser"("email");
