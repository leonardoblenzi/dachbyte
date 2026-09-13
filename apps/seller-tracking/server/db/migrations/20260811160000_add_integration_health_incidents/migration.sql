-- Migration: 20260811160000_add_integration_health_incidents
-- Module: avantracking
-- Purpose: Persist integration configuration and authentication incidents to deduplicate alerts.

BEGIN;

CREATE TABLE IF NOT EXISTS "IntegrationHealthIncident" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "integration" TEXT NOT NULL,
  "issueCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "lastNotifiedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationHealthIncident_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IntegrationHealthIncident"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "integration" TEXT,
  ADD COLUMN IF NOT EXISTS "issueCode" TEXT,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS "title" TEXT,
  ADD COLUMN IF NOT EXISTS "message" TEXT,
  ADD COLUMN IF NOT EXISTS "lastNotifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationHealthIncident_company_integration_issue_key"
  ON "IntegrationHealthIncident" ("companyId", "integration", "issueCode");

CREATE INDEX IF NOT EXISTS "IntegrationHealthIncident_company_status_updated_idx"
  ON "IntegrationHealthIncident" ("companyId", "status", "updatedAt" DESC);

COMMIT;
