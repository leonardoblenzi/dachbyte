CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_costs (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  reference_sku text NOT NULL,
  custo_produto_unitario numeric(14,2) NOT NULL DEFAULT 0,
  updated_by bigint NULL,
  source text NOT NULL DEFAULT 'manual',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadolivre_sku_costs_uq UNIQUE (account_key, reference_sku)
);

CREATE INDEX IF NOT EXISTS idx_mercadolivre_sku_costs_account
  ON ml.mercadolivre_sku_costs (account_key);

CREATE INDEX IF NOT EXISTS idx_mercadolivre_sku_costs_sku
  ON ml.mercadolivre_sku_costs (reference_sku);

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_cost_history (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  reference_sku text NOT NULL,
  custo_produto_unitario numeric(14,2) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  changed_by bigint NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mercadolivre_sku_cost_history_account_sku
  ON ml.mercadolivre_sku_cost_history (account_key, reference_sku, created_at DESC);

CREATE TABLE IF NOT EXISTS ml.mercadolivre_finance_settings (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL UNIQUE,
  aliquota numeric(8,4) NOT NULL DEFAULT 0,
  updated_by bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ml.mercadolivre_finance_settings_history (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  aliquota numeric(8,4) NOT NULL DEFAULT 0,
  changed_by bigint NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mercadolivre_finance_settings_history_account
  ON ml.mercadolivre_finance_settings_history (account_key, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'ml'
       AND table_name = 'rentabilidade_account_settings'
  ) THEN
    INSERT INTO ml.mercadolivre_finance_settings
      (account_key, aliquota, updated_by, created_at, updated_at)
    SELECT
      account_key,
      aliquota,
      updated_by,
      created_at,
      updated_at
      FROM ml.rentabilidade_account_settings
     WHERE COALESCE(aliquota, 0) > 0
    ON CONFLICT (account_key)
    DO UPDATE SET
      aliquota = EXCLUDED.aliquota,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();
  END IF;
END $$;
