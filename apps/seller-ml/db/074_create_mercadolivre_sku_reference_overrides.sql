CREATE SCHEMA IF NOT EXISTS ml;

-- Alguns anúncios legados não expõem SELLER_SKU para a conta autenticada.
-- Este vínculo explícito mantém o custo centralizado por SKU sem usar o MLB
-- como chave financeira definitiva.
CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_reference_overrides (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  mlb text NOT NULL,
  variation_id text NOT NULL DEFAULT '',
  reference_sku text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_by text NULL,
  updated_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadolivre_sku_reference_overrides_uq
    UNIQUE (account_key, mlb, variation_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_reference_overrides_account_mlb
  ON ml.mercadolivre_sku_reference_overrides (account_key, mlb);

CREATE INDEX IF NOT EXISTS idx_ml_sku_reference_overrides_account_sku
  ON ml.mercadolivre_sku_reference_overrides (account_key, reference_sku);
