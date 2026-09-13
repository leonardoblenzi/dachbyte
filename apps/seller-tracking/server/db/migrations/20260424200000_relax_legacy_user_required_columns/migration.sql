-- Migration: 20260424200000_relax_legacy_user_required_columns
-- Module: avantracking

BEGIN;

DO $$
DECLARE
  rec RECORD;
BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  -- Legacy column often present in old schemas but absent in current app model.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'passwordHash'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'password'
    ) THEN
      UPDATE "User"
      SET "password" = COALESCE(NULLIF("password", ''), "passwordHash"::text, '')
      WHERE "password" IS NULL OR "password" = '';
    END IF;

    BEGIN
      ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel remover NOT NULL de User.passwordHash: %', SQLERRM;
    END;
  END IF;

  -- Any extra mandatory column with no default can break Prisma inserts.
  FOR rec IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND is_nullable = 'NO'
      AND column_default IS NULL
      AND is_identity = 'NO'
      AND is_generated = 'NEVER'
      AND column_name NOT IN (
        'id',
        'name',
        'email',
        'password',
        'role',
        'createdAt',
        'updatedAt'
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE "User" ALTER COLUMN %I DROP NOT NULL', rec.column_name);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel remover NOT NULL de User.%: %', rec.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

DO $$
DECLARE
  rec RECORD;
BEGIN
  IF to_regclass('public."LogisyncUser"') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LogisyncUser'
      AND column_name = 'passwordHash'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'LogisyncUser'
        AND column_name = 'password'
    ) THEN
      UPDATE "LogisyncUser"
      SET "password" = COALESCE(NULLIF("password", ''), "passwordHash"::text, '')
      WHERE "password" IS NULL OR "password" = '';
    END IF;

    BEGIN
      ALTER TABLE "LogisyncUser" ALTER COLUMN "passwordHash" DROP NOT NULL;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel remover NOT NULL de LogisyncUser.passwordHash: %', SQLERRM;
    END;
  END IF;

  FOR rec IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LogisyncUser'
      AND is_nullable = 'NO'
      AND column_default IS NULL
      AND is_identity = 'NO'
      AND is_generated = 'NEVER'
      AND column_name NOT IN (
        'id',
        'email',
        'name',
        'password',
        'role',
        'isActive',
        'createdAt',
        'updatedAt'
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE "LogisyncUser" ALTER COLUMN %I DROP NOT NULL', rec.column_name);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel remover NOT NULL de LogisyncUser.%: %', rec.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

COMMIT;
