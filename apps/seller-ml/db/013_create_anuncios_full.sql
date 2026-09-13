-- db/00X_create_anuncios_full.sql
-- FULL • Produtos Fulfillment (por meli_conta_id)

BEGIN;

CREATE TABLE IF NOT EXISTS anuncios_full (
  id BIGSERIAL PRIMARY KEY,

  meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
  mlb TEXT NOT NULL,

  -- SKU “principal” (quando existir)
  sku TEXT,

  -- Dados básicos do anúncio
  title TEXT,
  image_url TEXT,

  -- Identificador do inventário (necessário p/ fulfillment)
  inventory_id TEXT,

  -- Preço cheio (preço do anúncio)
  price NUMERIC(14,2),

  -- Estoque disponível no Fulfillment
  stock_full INTEGER NOT NULL DEFAULT 0,

  -- Vendas (cache do app)
  sold_40d INTEGER NOT NULL DEFAULT 0,
  sold_total INTEGER NOT NULL DEFAULT 0,

  -- Status (UI / anúncio)
  listing_status TEXT,
  status TEXT,

  -- (opcional) histórico/série (pra gráfico)
  sales_series_40d JSONB,

  last_synced_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique por conta + mlb
CREATE UNIQUE INDEX IF NOT EXISTS ux_anuncios_full_conta_mlb
  ON anuncios_full (meli_conta_id, mlb);

-- Índices úteis
CREATE INDEX IF NOT EXISTS ix_anuncios_full_conta_updated
  ON anuncios_full (meli_conta_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_anuncios_full_mlb
  ON anuncios_full (mlb);

CREATE INDEX IF NOT EXISTS ix_anuncios_full_sku
  ON anuncios_full (sku);

-- Checks básicos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_anuncios_full_nonneg'
  ) THEN
    ALTER TABLE anuncios_full
      ADD CONSTRAINT ck_anuncios_full_nonneg
      CHECK (
        (price IS NULL OR price >= 0)
        AND (stock_full >= 0)
        AND (sold_40d >= 0)
        AND (sold_total >= 0)
      );
  END IF;
END $$;

COMMIT;
