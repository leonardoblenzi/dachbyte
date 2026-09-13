-- Migration: 20260424230000_ensure_numeric_identity_compatibility
-- Module: shopee
-- Purpose: Normalize identity/FK columns to INTEGER when drifted to TEXT

BEGIN;

DO $$
DECLARE
  external_fk_count INTEGER;
  external_fk_details TEXT;
BEGIN
  SELECT
    COUNT(*)::int,
    STRING_AGG(
      format('%I.%I', src.relname, src_att.attname),
      ', '
      ORDER BY src.relname, src_att.attname
    )
  INTO external_fk_count, external_fk_details
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  JOIN pg_attribute src_att
    ON src_att.attrelid = c.conrelid
   AND src_att.attnum = c.conkey[1]
  WHERE c.contype = 'f'
    AND tgt.relname = 'User'
    AND src.relname IN ('UserAccessToken', 'MonitoredOrder')
    AND src_att.attname IN ('userId', 'createdById');

  IF external_fk_count > 0 THEN
    RAISE EXCEPTION
      'Banco incompativel para o modulo Shopee: FKs externas para User.id detectadas (%). Configure DATABASE_URL do Shopee para um banco/schema dedicado.',
      COALESCE(external_fk_details, 'sem detalhes');
  END IF;
END $$;

DO $$
DECLARE
  max_numeric_id BIGINT;
BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'id'
      AND data_type IN ('text', 'character varying', 'character')
  ) THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX(("id")::bigint), 0)
  INTO max_numeric_id
  FROM "User"
  WHERE BTRIM("id"::text) ~ '^[0-9]+$';

  CREATE TEMP TABLE "_tmp_user_id_map" (
    old_id TEXT PRIMARY KEY,
    new_id INTEGER NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO "_tmp_user_id_map" (old_id, new_id)
  SELECT
    "id"::text AS old_id,
    (max_numeric_id + ROW_NUMBER() OVER (ORDER BY "createdAt" NULLS LAST, "id"))::integer AS new_id
  FROM "User"
  WHERE BTRIM("id"::text) !~ '^[0-9]+$';

  UPDATE "User" u
  SET "id" = m.new_id::text
  FROM "_tmp_user_id_map" m
  WHERE u."id"::text = m.old_id;

  IF to_regclass('public."Session"') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Session'
        AND column_name = 'userId'
    ) THEN
      UPDATE "Session" s
      SET "userId" = m.new_id
      FROM "_tmp_user_id_map" m
      WHERE s."userId"::text = m.old_id;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Session'
        AND column_name = 'realUserId'
    ) THEN
      UPDATE "Session" s
      SET "realUserId" = m.new_id
      FROM "_tmp_user_id_map" m
      WHERE s."realUserId"::text = m.old_id;
    END IF;
  END IF;

  IF to_regclass('public."ListingCloneDraft"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ListingCloneDraft'
        AND column_name = 'userId'
    ) THEN
    UPDATE "ListingCloneDraft" d
    SET "userId" = m.new_id
    FROM "_tmp_user_id_map" m
    WHERE d."userId"::text = m.old_id;
  END IF;

  IF to_regclass('public."ProductBoostBatch"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ProductBoostBatch'
        AND column_name = 'userId'
    ) THEN
    UPDATE "ProductBoostBatch" b
    SET "userId" = m.new_id
    FROM "_tmp_user_id_map" m
    WHERE b."userId"::text = m.old_id;
  END IF;

  IF to_regclass('public."AuthAudit"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'AuthAudit'
        AND column_name = 'userId'
    ) THEN
    UPDATE "AuthAudit" a
    SET "userId" = m.new_id
    FROM "_tmp_user_id_map" m
    WHERE a."userId"::text = m.old_id;
  END IF;

  IF to_regclass('public."Session"') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'userId'
    ) THEN
      DELETE FROM "Session" s
      WHERE s."userId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "User" u WHERE u."id"::text = s."userId"::text
        );
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'realUserId'
    ) THEN
      UPDATE "Session" s
      SET "realUserId" = NULL
      WHERE s."realUserId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "User" u WHERE u."id"::text = s."realUserId"::text
        );
    END IF;
  END IF;

  IF to_regclass('public."ListingCloneDraft"') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ListingCloneDraft' AND column_name = 'userId'
    ) THEN
    UPDATE "ListingCloneDraft" d
    SET "userId" = NULL
    WHERE d."userId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u."id"::text = d."userId"::text
      );
  END IF;

  IF to_regclass('public."ProductBoostBatch"') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ProductBoostBatch' AND column_name = 'userId'
    ) THEN
    UPDATE "ProductBoostBatch" b
    SET "userId" = NULL
    WHERE b."userId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u."id"::text = b."userId"::text
      );
  END IF;

  IF to_regclass('public."AuthAudit"') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AuthAudit' AND column_name = 'userId'
    ) THEN
    UPDATE "AuthAudit" a
    SET "userId" = NULL
    WHERE a."userId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u."id"::text = a."userId"::text
      );
  END IF;
END $$;

DO $$
DECLARE
  target RECORD;
  invalid_count BIGINT;
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('Account', 'id', FALSE),
        ('Shop', 'id', FALSE),
        ('Shop', 'accountId', TRUE),
        ('OAuthToken', 'id', FALSE),
        ('OAuthToken', 'shopId', FALSE),
        ('User', 'id', FALSE),
        ('User', 'accountId', FALSE),
        ('Session', 'userId', FALSE),
        ('Session', 'activeShopId', TRUE),
        ('Session', 'realUserId', TRUE),
        ('Product', 'id', FALSE),
        ('Product', 'shopId', FALSE),
        ('ProductImage', 'id', FALSE),
        ('ProductImage', 'productId', FALSE),
        ('ProductModel', 'id', FALSE),
        ('ProductModel', 'productId', FALSE),
        ('Order', 'id', FALSE),
        ('Order', 'shopId', FALSE),
        ('OrderAddressSnapshot', 'id', FALSE),
        ('OrderAddressSnapshot', 'orderId', FALSE),
        ('OrderAddressChangeAlert', 'id', FALSE),
        ('OrderAddressChangeAlert', 'orderId', FALSE),
        ('OrderAddressChangeAlert', 'oldSnapshotId', TRUE),
        ('OrderAddressChangeAlert', 'newSnapshotId', FALSE),
        ('OrderAddressChangeAlert', 'orderAddressSnapshotId', TRUE),
        ('OrderGeoAddress', 'id', FALSE),
        ('OrderGeoAddress', 'shopId', FALSE),
        ('OrderGeoAddress', 'orderId', FALSE),
        ('OrderItem', 'id', FALSE),
        ('OrderItem', 'shopId', FALSE),
        ('OrderItem', 'orderId', FALSE),
        ('OrderItem', 'productId', TRUE),
        ('AdsCampaignGroup', 'id', FALSE),
        ('AdsCampaignGroup', 'shopId', FALSE),
        ('AdsCampaignGroupCampaign', 'id', FALSE),
        ('AdsCampaignGroupCampaign', 'groupId', FALSE),
        ('AdsHourlyMetric', 'id', FALSE),
        ('AdsHourlyMetric', 'shopId', FALSE),
        ('OrderAdsAttribution', 'id', FALSE),
        ('OrderAdsAttribution', 'shopId', FALSE),
        ('OrderAdsAttribution', 'orderId', FALSE),
        ('DiscountCampaign', 'id', FALSE),
        ('DiscountCampaign', 'shopId', FALSE),
        ('DiscountItem', 'id', FALSE),
        ('DiscountItem', 'campaignId', FALSE),
        ('DiscountItem', 'productId', TRUE),
        ('AuthAudit', 'id', FALSE),
        ('AuthAudit', 'userId', TRUE),
        ('ListingCloneDraft', 'id', FALSE),
        ('ListingCloneDraft', 'shopId', FALSE),
        ('ListingCloneDraft', 'userId', TRUE),
        ('ProductBoostBatch', 'id', FALSE),
        ('ProductBoostBatch', 'shopId', FALSE),
        ('ProductBoostBatch', 'userId', TRUE),
        ('ProductBoostBatchItem', 'id', FALSE),
        ('ProductBoostBatchItem', 'batchId', FALSE),
        ('ProductBoostBatchItem', 'shopId', FALSE),
        ('ReleaseNote', 'id', FALSE)
    ) AS x(table_name, column_name, nullable_col)
  LOOP
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
    ) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
        AND data_type IN ('text', 'character varying', 'character')
    ) THEN
      IF target.nullable_col THEN
        EXECUTE format(
          'SELECT COUNT(*) FROM %I WHERE %I IS NOT NULL AND BTRIM(%I::text) <> '''' AND BTRIM(%I::text) !~ ''^[0-9]+$''',
          target.table_name,
          target.column_name,
          target.column_name,
          target.column_name
        ) INTO invalid_count;

        IF invalid_count > 0 THEN
          RAISE EXCEPTION
            'Schema divergence em %.%: % valor(es) nao numericos impedem conversao para INTEGER.',
            target.table_name,
            target.column_name,
            invalid_count;
        END IF;

        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE INTEGER USING NULLIF(BTRIM(%I::text), '''')::integer',
          target.table_name,
          target.column_name,
          target.column_name
        );
      ELSE
        EXECUTE format(
          'SELECT COUNT(*) FROM %I WHERE %I IS NULL OR BTRIM(%I::text) = '''' OR BTRIM(%I::text) !~ ''^[0-9]+$''',
          target.table_name,
          target.column_name,
          target.column_name,
          target.column_name
        ) INTO invalid_count;

        IF invalid_count > 0 THEN
          RAISE EXCEPTION
            'Schema divergence em %.%: % valor(es) invalidos impedem conversao para INTEGER.',
            target.table_name,
            target.column_name,
            invalid_count;
        END IF;

        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE INTEGER USING BTRIM(%I::text)::integer',
          target.table_name,
          target.column_name,
          target.column_name
        );
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  t_name TEXT;
  seq_name TEXT;
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'Account',
    'Shop',
    'OAuthToken',
    'User',
    'Product',
    'ProductImage',
    'ProductModel',
    'Order',
    'OrderAddressSnapshot',
    'OrderAddressChangeAlert',
    'OrderGeoAddress',
    'OrderItem',
    'AdsCampaignGroup',
    'AdsCampaignGroupCampaign',
    'AdsHourlyMetric',
    'OrderAdsAttribution',
    'DiscountCampaign',
    'DiscountItem',
    'AuthAudit',
    'ReleaseNote',
    'ListingCloneDraft',
    'ProductBoostBatch',
    'ProductBoostBatchItem'
  ]
  LOOP
    IF to_regclass(format('public.%I', t_name)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t_name
        AND column_name = 'id'
    ) THEN
      CONTINUE;
    END IF;

    seq_name := t_name || '_id_seq';

    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', seq_name);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(%L::regclass)',
      t_name,
      format('%I', seq_name)
    );
    EXECUTE format(
      'SELECT setval(%L::regclass, COALESCE((SELECT MAX(id) FROM %I), 0) + 1, false)',
      format('%I', seq_name),
      t_name
    );
  END LOOP;
END $$;

DO $$
DECLARE
  fk RECORD;
  source_udt TEXT;
  target_udt TEXT;
BEGIN
  FOR fk IN
    SELECT *
    FROM (
      VALUES
        ('Shop_accountId_fkey', 'Shop', 'accountId', 'Account', 'id', 'CASCADE'),
        ('OAuthToken_shopId_fkey', 'OAuthToken', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('User_accountId_fkey', 'User', 'accountId', 'Account', 'id', 'CASCADE'),
        ('Session_userId_fkey', 'Session', 'userId', 'User', 'id', 'CASCADE'),
        ('Session_activeShopId_fkey', 'Session', 'activeShopId', 'Shop', 'id', 'SET NULL'),
        ('Session_realUserId_fkey', 'Session', 'realUserId', 'User', 'id', 'SET NULL'),
        ('Product_shopId_fkey', 'Product', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('ProductImage_productId_fkey', 'ProductImage', 'productId', 'Product', 'id', 'CASCADE'),
        ('ProductModel_productId_fkey', 'ProductModel', 'productId', 'Product', 'id', 'CASCADE'),
        ('Order_shopId_fkey', 'Order', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('OrderAddressSnapshot_orderId_fkey', 'OrderAddressSnapshot', 'orderId', 'Order', 'id', 'CASCADE'),
        ('OrderAddressChangeAlert_orderId_fkey', 'OrderAddressChangeAlert', 'orderId', 'Order', 'id', 'CASCADE'),
        ('OrderAddressChangeAlert_oldSnapshotId_fkey', 'OrderAddressChangeAlert', 'oldSnapshotId', 'OrderAddressSnapshot', 'id', 'SET NULL'),
        ('OrderAddressChangeAlert_newSnapshotId_fkey', 'OrderAddressChangeAlert', 'newSnapshotId', 'OrderAddressSnapshot', 'id', 'CASCADE'),
        ('OrderAddressChangeAlert_orderAddressSnapshotId_fkey', 'OrderAddressChangeAlert', 'orderAddressSnapshotId', 'OrderAddressSnapshot', 'id', 'SET NULL'),
        ('OrderGeoAddress_shopId_fkey', 'OrderGeoAddress', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('OrderGeoAddress_orderId_fkey', 'OrderGeoAddress', 'orderId', 'Order', 'id', 'CASCADE'),
        ('OrderItem_shopId_fkey', 'OrderItem', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('OrderItem_orderId_fkey', 'OrderItem', 'orderId', 'Order', 'id', 'CASCADE'),
        ('OrderItem_productId_fkey', 'OrderItem', 'productId', 'Product', 'id', 'SET NULL'),
        ('AdsCampaignGroup_shopId_fkey', 'AdsCampaignGroup', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('AdsCampaignGroupCampaign_groupId_fkey', 'AdsCampaignGroupCampaign', 'groupId', 'AdsCampaignGroup', 'id', 'CASCADE'),
        ('AdsHourlyMetric_shopId_fkey', 'AdsHourlyMetric', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('OrderAdsAttribution_shopId_fkey', 'OrderAdsAttribution', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('OrderAdsAttribution_orderId_fkey', 'OrderAdsAttribution', 'orderId', 'Order', 'id', 'CASCADE'),
        ('DiscountCampaign_shopId_fkey', 'DiscountCampaign', 'shopId', 'Shop', 'id', 'RESTRICT'),
        ('DiscountItem_campaignId_fkey', 'DiscountItem', 'campaignId', 'DiscountCampaign', 'id', 'CASCADE'),
        ('DiscountItem_productId_fkey', 'DiscountItem', 'productId', 'Product', 'id', 'SET NULL'),
        ('AuthAudit_userId_fkey', 'AuthAudit', 'userId', 'User', 'id', 'SET NULL'),
        ('ListingCloneDraft_shopId_fkey', 'ListingCloneDraft', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('ListingCloneDraft_userId_fkey', 'ListingCloneDraft', 'userId', 'User', 'id', 'SET NULL'),
        ('ProductBoostBatch_shopId_fkey', 'ProductBoostBatch', 'shopId', 'Shop', 'id', 'CASCADE'),
        ('ProductBoostBatch_userId_fkey', 'ProductBoostBatch', 'userId', 'User', 'id', 'SET NULL'),
        ('ProductBoostBatchItem_batchId_fkey', 'ProductBoostBatchItem', 'batchId', 'ProductBoostBatch', 'id', 'CASCADE'),
        ('ProductBoostBatchItem_shopId_fkey', 'ProductBoostBatchItem', 'shopId', 'Shop', 'id', 'CASCADE')
    ) AS x(constraint_name, source_table, source_column, target_table, target_column, on_delete_action)
  LOOP
    IF to_regclass(format('public.%I', fk.source_table)) IS NULL
      OR to_regclass(format('public.%I', fk.target_table)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = fk.source_table
        AND column_name = fk.source_column
    ) OR NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = fk.target_table
        AND column_name = fk.target_column
    ) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = fk.constraint_name
    ) THEN
      CONTINUE;
    END IF;

    SELECT udt_name
    INTO source_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = fk.source_table
      AND column_name = fk.source_column;

    SELECT udt_name
    INTO target_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = fk.target_table
      AND column_name = fk.target_column;

    IF source_udt IS DISTINCT FROM target_udt THEN
      RAISE EXCEPTION
        'Schema divergence: nao foi possivel criar % (%.%=% e %.%=%).',
        fk.constraint_name,
        fk.source_table,
        fk.source_column,
        COALESCE(source_udt, 'null'),
        fk.target_table,
        fk.target_column,
        COALESCE(target_udt, 'null');
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s ON UPDATE CASCADE',
      fk.source_table,
      fk.constraint_name,
      fk.source_column,
      fk.target_table,
      fk.target_column,
      fk.on_delete_action
    );
  END LOOP;
END $$;

COMMIT;
