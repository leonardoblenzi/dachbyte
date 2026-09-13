-- CreateEnum
CREATE TYPE "MadUserRole" AS ENUM ('admin_master', 'admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "MadUserStatus" AS ENUM ('active', 'invited', 'disabled');

-- CreateTable
CREATE TABLE "MadUser" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "MadUserRole" NOT NULL DEFAULT 'viewer',
    "status" "MadUserStatus" NOT NULL DEFAULT 'active',
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MadUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MadUser_email_key" ON "MadUser"("email");

-- CreateIndex
CREATE INDEX "MadUser_workspaceId_role_idx" ON "MadUser"("workspaceId", "role");

-- CreateIndex
CREATE INDEX "MadUser_status_idx" ON "MadUser"("status");

-- AddForeignKey
ALTER TABLE "MadUser" ADD CONSTRAINT "MadUser_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MadWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
