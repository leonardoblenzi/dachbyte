-- Migration: 20260525143000_add_admin_master_oauth_state_and_audit_retention
-- Module: shopee
-- Executada manualmente no banco definido em DATABASE_URL

BEGIN;

CREATE TABLE IF NOT EXISTS "OAuthState" (
  "id" SERIAL NOT NULL,
  state TEXT NOT NULL,
  flow TEXT NOT NULL DEFAULT 'shop',
  "userId" INTEGER,
  "accountId" INTEGER,
  "returnTo" TEXT,
  status TEXT NOT NULL DEFAULT 'ISSUED',
  "shopId" BIGINT,
  metadata JSONB,
  "expiresAt" TIMESTAMPTZ,
  "consumedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OAuthState_state_key" ON "OAuthState"(state);
CREATE INDEX IF NOT EXISTS "OAuthState_createdAt_idx" ON "OAuthState"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "OAuthState_userId_idx" ON "OAuthState"("userId");
CREATE INDEX IF NOT EXISTS "OAuthState_accountId_idx" ON "OAuthState"("accountId");
CREATE INDEX IF NOT EXISTS "OAuthState_status_idx" ON "OAuthState"(status);
CREATE INDEX IF NOT EXISTS "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

DO $$
DECLARE
  oauth_user_udt TEXT;
  user_id_udt TEXT;
  oauth_account_udt TEXT;
  account_id_udt TEXT;
BEGIN
  SELECT c.udt_name
  INTO oauth_user_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'OAuthState'
    AND c.column_name = 'userId';

  SELECT c.udt_name
  INTO user_id_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'User'
    AND c.column_name = 'id';

  IF to_regclass('public."User"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'OAuthState_userId_fkey'
     )
     AND oauth_user_udt IS NOT NULL
     AND user_id_udt IS NOT NULL
     AND oauth_user_udt = user_id_udt THEN
    ALTER TABLE "OAuthState"
      ADD CONSTRAINT "OAuthState_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;

  SELECT c.udt_name
  INTO oauth_account_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'OAuthState'
    AND c.column_name = 'accountId';

  SELECT c.udt_name
  INTO account_id_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'Account'
    AND c.column_name = 'id';

  IF to_regclass('public."Account"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'OAuthState_accountId_fkey'
     )
     AND oauth_account_udt IS NOT NULL
     AND account_id_udt IS NOT NULL
     AND oauth_account_udt = account_id_udt THEN
    ALTER TABLE "OAuthState"
      ADD CONSTRAINT "OAuthState_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AuthAuditRetentionRule" (
  event TEXT NOT NULL,
  description TEXT,
  "retentionDays" INTEGER NOT NULL DEFAULT 90,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "AuthAuditRetentionRule_pkey" PRIMARY KEY (event)
);

INSERT INTO "AuthAuditRetentionRule" (event, description, "retentionDays")
VALUES (
  '*DEFAULT*',
  'Regra padrao para eventos sem configuracao dedicada.',
  90
)
ON CONFLICT (event)
DO NOTHING;

COMMIT;
