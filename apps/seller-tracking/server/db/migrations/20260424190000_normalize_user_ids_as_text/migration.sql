-- Migration: 20260424190000_normalize_user_ids_as_text
-- Module: avantracking

BEGIN;

-- Remove FKs that reference User.id so type normalization can run safely.
DO $$
DECLARE
  rec RECORD;
BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f'
      AND con.confrelid = 'public."User"'::regclass
      AND n.nspname = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      rec.schema_name,
      rec.table_name,
      rec.constraint_name
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'id'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "User" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "User" ALTER COLUMN "id" TYPE TEXT USING "id"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LogisyncUser'
      AND column_name = 'id'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "LogisyncUser" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "LogisyncUser" ALTER COLUMN "id" TYPE TEXT USING "id"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'UserAccessToken'
      AND column_name = 'userId'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "UserAccessToken" ALTER COLUMN "userId" TYPE TEXT USING "userId"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'createdById'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "Order" ALTER COLUMN "createdById" TYPE TEXT USING "createdById"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ReleaseNote'
      AND column_name = 'sentByUserId'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "ReleaseNote" ALTER COLUMN "sentByUserId" TYPE TEXT USING "sentByUserId"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'MonitoredOrder'
      AND column_name = 'createdById'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "MonitoredOrder" ALTER COLUMN "createdById" TYPE TEXT USING "createdById"::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'CompanyOrderCustomStatus'
      AND column_name = 'createdById'
      AND udt_name <> 'text'
  ) THEN
    ALTER TABLE "CompanyOrderCustomStatus" ALTER COLUMN "createdById" TYPE TEXT USING "createdById"::text;
  END IF;
END $$;

-- Clean orphan references before recreating constraints.
DO $$
BEGIN
  IF to_regclass('public."UserAccessToken"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'UserAccessToken'
        AND column_name = 'userId'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'id'
    ) THEN
    DELETE FROM "UserAccessToken" t
    WHERE t."userId" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "User" u
         WHERE u."id"::text = t."userId"::text
       );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."Order"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Order'
        AND column_name = 'createdById'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'id'
    ) THEN
    UPDATE "Order" o
    SET "createdById" = NULL
    WHERE o."createdById" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "User" u
        WHERE u."id"::text = o."createdById"::text
      );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."ReleaseNote"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ReleaseNote'
        AND column_name = 'sentByUserId'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'id'
    ) THEN
    UPDATE "ReleaseNote" r
    SET "sentByUserId" = NULL
    WHERE r."sentByUserId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "User" u
        WHERE u."id"::text = r."sentByUserId"::text
      );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'MonitoredOrder'
        AND column_name = 'createdById'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'id'
    ) THEN
    UPDATE "MonitoredOrder" m
    SET "createdById" = NULL
    WHERE m."createdById" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "User" u
        WHERE u."id"::text = m."createdById"::text
      );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."CompanyOrderCustomStatus"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'CompanyOrderCustomStatus'
        AND column_name = 'createdById'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'id'
    ) THEN
    UPDATE "CompanyOrderCustomStatus" s
    SET "createdById" = NULL
    WHERE s."createdById" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "User" u
        WHERE u."id"::text = s."createdById"::text
      );
  END IF;
END $$;

-- Recreate standard relations to User.id where types are compatible.
DO $$
DECLARE
  user_id_udt TEXT;
  token_user_id_udt TEXT;
BEGIN
  IF to_regclass('public."UserAccessToken"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

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

  IF COALESCE(user_id_udt, '') = COALESCE(token_user_id_udt, '')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'UserAccessToken_userId_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "UserAccessToken"
        ADD CONSTRAINT "UserAccessToken_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar UserAccessToken_userId_fkey: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
DECLARE
  user_id_udt TEXT;
  order_created_by_udt TEXT;
BEGIN
  IF to_regclass('public."Order"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  SELECT udt_name
  INTO user_id_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'User'
    AND column_name = 'id';

  SELECT udt_name
  INTO order_created_by_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'Order'
    AND column_name = 'createdById';

  IF COALESCE(user_id_udt, '') = COALESCE(order_created_by_udt, '')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'Order_createdById_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "Order"
        ADD CONSTRAINT "Order_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar Order_createdById_fkey: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
DECLARE
  user_id_udt TEXT;
  release_sent_by_udt TEXT;
BEGIN
  IF to_regclass('public."ReleaseNote"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  SELECT udt_name
  INTO user_id_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'User'
    AND column_name = 'id';

  SELECT udt_name
  INTO release_sent_by_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'ReleaseNote'
    AND column_name = 'sentByUserId';

  IF COALESCE(user_id_udt, '') = COALESCE(release_sent_by_udt, '')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'ReleaseNote_sentByUserId_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "ReleaseNote"
        ADD CONSTRAINT "ReleaseNote_sentByUserId_fkey"
        FOREIGN KEY ("sentByUserId") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar ReleaseNote_sentByUserId_fkey: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
DECLARE
  user_id_udt TEXT;
  monitored_created_by_udt TEXT;
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  SELECT udt_name
  INTO user_id_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'User'
    AND column_name = 'id';

  SELECT udt_name
  INTO monitored_created_by_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'MonitoredOrder'
    AND column_name = 'createdById';

  IF COALESCE(user_id_udt, '') = COALESCE(monitored_created_by_udt, '')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'MonitoredOrder_createdById_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "MonitoredOrder"
        ADD CONSTRAINT "MonitoredOrder_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar MonitoredOrder_createdById_fkey: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
DECLARE
  user_id_udt TEXT;
  custom_status_created_by_udt TEXT;
BEGIN
  IF to_regclass('public."CompanyOrderCustomStatus"') IS NULL OR to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  SELECT udt_name
  INTO user_id_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'User'
    AND column_name = 'id';

  SELECT udt_name
  INTO custom_status_created_by_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'CompanyOrderCustomStatus'
    AND column_name = 'createdById';

  IF COALESCE(user_id_udt, '') = COALESCE(custom_status_created_by_udt, '')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'CompanyOrderCustomStatus_createdById_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "CompanyOrderCustomStatus"
        ADD CONSTRAINT "CompanyOrderCustomStatus_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar CompanyOrderCustomStatus_createdById_fkey: %', SQLERRM;
    END;
  END IF;
END $$;

COMMIT;
