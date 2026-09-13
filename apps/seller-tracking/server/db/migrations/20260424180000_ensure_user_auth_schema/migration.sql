-- Migration: 20260424180000_ensure_user_auth_schema
-- Module: avantracking

BEGIN;

DO $$
DECLARE
  has_admin BOOLEAN;
  has_user BOOLEAN;
  rec RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
    CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');
    RETURN;
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'Role' AND e.enumlabel = 'ADMIN'
    ),
    EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'Role' AND e.enumlabel = 'USER'
    )
  INTO has_admin, has_user;

  IF has_admin AND has_user THEN
    RETURN;
  END IF;

  CREATE TYPE "Role__tmp_fix" AS ENUM ('ADMIN', 'USER');

  FOR rec IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE udt_name = 'Role'
      AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
      rec.table_schema,
      rec.table_name,
      rec.column_name
    );

    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE "Role__tmp_fix" USING (CASE WHEN UPPER(COALESCE(%I::text, '''')) = ''ADMIN'' THEN ''ADMIN''::"Role__tmp_fix" ELSE ''USER''::"Role__tmp_fix" END)',
      rec.table_schema,
      rec.table_name,
      rec.column_name,
      rec.column_name
    );
  END LOOP;

  DROP TYPE "Role";
  ALTER TYPE "Role__tmp_fix" RENAME TO "Role";
END $$;

DO $$
DECLARE
  has_admin_super BOOLEAN;
  has_analyst BOOLEAN;
  rec RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LogisyncRole') THEN
    CREATE TYPE "LogisyncRole" AS ENUM ('ADMIN_SUPER', 'ANALYST');
    RETURN;
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'LogisyncRole' AND e.enumlabel = 'ADMIN_SUPER'
    ),
    EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'LogisyncRole' AND e.enumlabel = 'ANALYST'
    )
  INTO has_admin_super, has_analyst;

  IF has_admin_super AND has_analyst THEN
    RETURN;
  END IF;

  CREATE TYPE "LogisyncRole__tmp_fix" AS ENUM ('ADMIN_SUPER', 'ANALYST');

  FOR rec IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE udt_name = 'LogisyncRole'
      AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
      rec.table_schema,
      rec.table_name,
      rec.column_name
    );

    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE "LogisyncRole__tmp_fix" USING (CASE WHEN UPPER(COALESCE(%I::text, '''')) = ''ADMIN_SUPER'' THEN ''ADMIN_SUPER''::"LogisyncRole__tmp_fix" ELSE ''ANALYST''::"LogisyncRole__tmp_fix" END)',
      rec.table_schema,
      rec.table_name,
      rec.column_name,
      rec.column_name
    );
  END LOOP;

  DROP TYPE "LogisyncRole";
  ALTER TYPE "LogisyncRole__tmp_fix" RENAME TO "LogisyncRole";
END $$;

CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password" TEXT NOT NULL DEFAULT '',
  "role" "Role" NOT NULL DEFAULT 'USER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "companyId" TEXT,
  "userGlobalId" TEXT,
  "phone" TEXT,
  "birthDate" TIMESTAMP(3),
  "profileImageData" TEXT,
  "lastBirthdayCelebrationAt" TIMESTAMP(3),
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "name" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "password" TEXT,
  ADD COLUMN IF NOT EXISTS "role" "Role" DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "userGlobalId" TEXT,
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "profileImageData" TEXT,
  ADD COLUMN IF NOT EXISTS "lastBirthdayCelebrationAt" TIMESTAMP(3);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'role'
      AND udt_name <> 'Role'
  ) THEN
    ALTER TABLE "User"
      ALTER COLUMN "role" TYPE "Role"
      USING CASE
        WHEN UPPER(COALESCE("role"::text, '')) = 'ADMIN' THEN 'ADMIN'::"Role"
        ELSE 'USER'::"Role"
      END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'password'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE "User"
      ALTER COLUMN "password" TYPE TEXT
      USING COALESCE("password"::text, '');
  END IF;
END $$;

UPDATE "User"
SET "name" = COALESCE(NULLIF(BTRIM(COALESCE("name"::text, '')), ''), 'Usuario')
WHERE "name" IS NULL OR BTRIM(COALESCE("name"::text, '')) = '';

UPDATE "User"
SET "email" = LOWER(BTRIM(COALESCE("email"::text, '')))
WHERE "email" IS NOT NULL;

UPDATE "User"
SET "email" = CONCAT(
  'user-',
  COALESCE(NULLIF(BTRIM(COALESCE("id"::text, '')), ''), md5(random()::text)),
  '@local.invalid'
)
WHERE "email" IS NULL OR BTRIM(COALESCE("email"::text, '')) = '';

UPDATE "User"
SET "password" = COALESCE("password", '')
WHERE "password" IS NULL;

UPDATE "User"
SET "role" = COALESCE("role", 'USER'::"Role")
WHERE "role" IS NULL;

UPDATE "User"
SET "createdAt" = COALESCE("createdAt", NOW())
WHERE "createdAt" IS NULL;

UPDATE "User"
SET "updatedAt" = COALESCE("updatedAt", "createdAt", NOW())
WHERE "updatedAt" IS NULL;

UPDATE "User"
SET "userGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "userGlobalId" IS NULL;

ALTER TABLE "User"
  ALTER COLUMN "password" SET DEFAULT '',
  ALTER COLUMN "role" SET DEFAULT 'USER',
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "User"
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "email" SET NOT NULL,
  ALTER COLUMN "password" SET NOT NULL,
  ALTER COLUMN "role" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

DO $$
BEGIN
  IF to_regclass('public."User_email_key"') IS NULL THEN
    BEGIN
      CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
    EXCEPTION
      WHEN unique_violation THEN
        RAISE NOTICE 'Nao foi possivel criar User_email_key por duplicidade de email.';
    END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_userGlobalId_unique"
  ON "User" ("userGlobalId");

CREATE TABLE IF NOT EXISTS "UserAccessToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL,
  CONSTRAINT "UserAccessToken_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UserAccessToken"
  ADD COLUMN IF NOT EXISTS "tokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "type" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "usedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "userId" TEXT;

DELETE FROM "UserAccessToken"
WHERE "tokenHash" IS NULL
   OR "type" IS NULL
   OR "expiresAt" IS NULL
   OR "userId" IS NULL;

ALTER TABLE "UserAccessToken"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "UserAccessToken"
  ALTER COLUMN "tokenHash" SET NOT NULL,
  ALTER COLUMN "type" SET NOT NULL,
  ALTER COLUMN "expiresAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "userId" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UserAccessToken_tokenHash_key"
  ON "UserAccessToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "UserAccessToken_userId_type_idx"
  ON "UserAccessToken"("userId", "type");
CREATE INDEX IF NOT EXISTS "UserAccessToken_expiresAt_idx"
  ON "UserAccessToken"("expiresAt");

DO $$
DECLARE
  user_id_udt TEXT;
  token_user_id_udt TEXT;
BEGIN
  IF to_regclass('public."UserAccessToken"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'UserAccessToken_userId_fkey'
    ) THEN
    DELETE FROM "UserAccessToken" t
    WHERE t."userId" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "User" u
         WHERE u."id"::text = t."userId"::text
       );

    SELECT udt_name
    INTO user_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'id';

    SELECT udt_name
    INTO token_user_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'UserAccessToken'
      AND column_name = 'userId';

    IF COALESCE(user_id_udt, '') = COALESCE(token_user_id_udt, '') THEN
      BEGIN
        ALTER TABLE "UserAccessToken"
          ADD CONSTRAINT "UserAccessToken_userId_fkey"
          FOREIGN KEY ("userId") REFERENCES "User"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar UserAccessToken_userId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando UserAccessToken_userId_fkey por incompatibilidade de tipo: User.id=% / UserAccessToken.userId=%', user_id_udt, token_user_id_udt;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "LogisyncUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "password" TEXT NOT NULL DEFAULT '',
  "role" "LogisyncRole" NOT NULL DEFAULT 'ANALYST',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "companyId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LogisyncUser_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LogisyncUser"
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "name" TEXT,
  ADD COLUMN IF NOT EXISTS "password" TEXT,
  ADD COLUMN IF NOT EXISTS "role" "LogisyncRole" DEFAULT 'ANALYST',
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LogisyncUser'
      AND column_name = 'role'
      AND udt_name <> 'LogisyncRole'
  ) THEN
    ALTER TABLE "LogisyncUser"
      ALTER COLUMN "role" TYPE "LogisyncRole"
      USING CASE
        WHEN UPPER(COALESCE("role"::text, '')) = 'ADMIN_SUPER' THEN 'ADMIN_SUPER'::"LogisyncRole"
        ELSE 'ANALYST'::"LogisyncRole"
      END;
  END IF;
END $$;

UPDATE "LogisyncUser"
SET "name" = COALESCE(NULLIF(BTRIM(COALESCE("name"::text, '')), ''), 'Logisync User')
WHERE "name" IS NULL OR BTRIM(COALESCE("name"::text, '')) = '';

UPDATE "LogisyncUser"
SET "email" = LOWER(BTRIM(COALESCE("email"::text, '')))
WHERE "email" IS NOT NULL;

UPDATE "LogisyncUser"
SET "email" = CONCAT(
  'logisync-user-',
  COALESCE(NULLIF(BTRIM(COALESCE("id"::text, '')), ''), md5(random()::text)),
  '@local.invalid'
)
WHERE "email" IS NULL OR BTRIM(COALESCE("email"::text, '')) = '';

UPDATE "LogisyncUser"
SET "password" = COALESCE("password", '')
WHERE "password" IS NULL;

UPDATE "LogisyncUser"
SET "role" = COALESCE("role", 'ANALYST'::"LogisyncRole")
WHERE "role" IS NULL;

UPDATE "LogisyncUser"
SET "isActive" = COALESCE("isActive", true)
WHERE "isActive" IS NULL;

UPDATE "LogisyncUser"
SET "createdAt" = COALESCE("createdAt", NOW())
WHERE "createdAt" IS NULL;

UPDATE "LogisyncUser"
SET "updatedAt" = COALESCE("updatedAt", "createdAt", NOW())
WHERE "updatedAt" IS NULL;

ALTER TABLE "LogisyncUser"
  ALTER COLUMN "password" SET DEFAULT '',
  ALTER COLUMN "role" SET DEFAULT 'ANALYST',
  ALTER COLUMN "isActive" SET DEFAULT true,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "LogisyncUser"
  ALTER COLUMN "email" SET NOT NULL,
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "password" SET NOT NULL,
  ALTER COLUMN "role" SET NOT NULL,
  ALTER COLUMN "isActive" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

DO $$
BEGIN
  IF to_regclass('public."LogisyncUser_email_key"') IS NULL THEN
    BEGIN
      CREATE UNIQUE INDEX "LogisyncUser_email_key" ON "LogisyncUser"("email");
    EXCEPTION
      WHEN unique_violation THEN
        RAISE NOTICE 'Nao foi possivel criar LogisyncUser_email_key por duplicidade de email.';
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "LogisyncUser_companyId_idx"
  ON "LogisyncUser"("companyId");

DO $$
DECLARE
  user_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."User"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'User_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO user_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(user_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "User"
          ADD CONSTRAINT "User_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar User_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando User_companyId_fkey por incompatibilidade de tipo: User.companyId=% / Company.id=%', user_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  logisync_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."LogisyncUser"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'LogisyncUser_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO logisync_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LogisyncUser'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(logisync_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "LogisyncUser"
          ADD CONSTRAINT "LogisyncUser_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar LogisyncUser_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando LogisyncUser_companyId_fkey por incompatibilidade de tipo: LogisyncUser.companyId=% / Company.id=%', logisync_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

COMMIT;
