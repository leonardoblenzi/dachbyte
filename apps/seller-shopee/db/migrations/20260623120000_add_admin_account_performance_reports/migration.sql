-- Migration: 20260623120000_add_admin_account_performance_reports
-- Module: shopee
-- Purpose: Persist Admin Master account performance report history and generated file references.

BEGIN;

CREATE TABLE IF NOT EXISTS "AdminAccountPerformanceReport" (
  id SERIAL NOT NULL,
  "accountId" INTEGER NOT NULL,
  "accountName" TEXT,
  "generatedByUserId" INTEGER,
  "generatedByEmail" TEXT,
  "periodFrom" TIMESTAMPTZ NOT NULL,
  "periodTo" TIMESTAMPTZ NOT NULL,
  "periodDays" INTEGER NOT NULL DEFAULT 90,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  progress INTEGER NOT NULL DEFAULT 0,
  "currentStep" TEXT,
  "xlsxPath" TEXT,
  "pdfPath" TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB,
  error TEXT,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "AdminAccountPerformanceReport_pkey" PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS "AdminAccountPerformanceReport_account_created_idx"
  ON "AdminAccountPerformanceReport"("accountId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdminAccountPerformanceReport_status_idx"
  ON "AdminAccountPerformanceReport"(status);

COMMIT;
