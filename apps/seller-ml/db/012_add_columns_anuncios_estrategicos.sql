-- db/00X_create_anuncios_estrategicos.sql
-- Produtos Estratégicos (por meli_conta_id)
-- Agora com: preco_original (cheio) + preco_promo (alvo) e % calculada (percent_default)

BEGIN;

CREATE TABLE IF NOT EXISTS anuncios_estrategicos (
  id BIGSERIAL PRIMARY KEY,

  meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
  mlb TEXT NOT NULL,

  -- Nome (vem do ML via sync)
  name TEXT,

  -- Preço cheio (sem promo ativa) e preço alvo da promo
  original_price NUMERIC(14,2),
  promo_price    NUMERIC(14,2),

  -- Mantemos esses campos (compat) e agora percent_default vira % calculada do promo_price vs original_price
  percent_default NUMERIC(6,2),
  percent_cycle   NUMERIC(6,2),
  percent_applied NUMERIC(6,2),

  -- Status do anúncio e status UI
  listing_status TEXT,
  status TEXT,

  last_synced_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Se sua tabela já existia, garante as colunas novas
ALTER TABLE anuncios_estrategicos
  ADD COLUMN IF NOT EXISTS original_price NUMERIC(14,2);

ALTER TABLE anuncios_estrategicos
  ADD COLUMN IF NOT EXISTS promo_price NUMERIC(14,2);

-- Garante unique por conta + mlb
CREATE UNIQUE INDEX IF NOT EXISTS ux_anuncios_estrategicos_conta_mlb
  ON anuncios_estrategicos (meli_conta_id, mlb);

-- Índices úteis
CREATE INDEX IF NOT EXISTS ix_anuncios_estrategicos_conta_updated
  ON anuncios_estrategicos (meli_conta_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_anuncios_estrategicos_mlb
  ON anuncios_estrategicos (mlb);

-- Checks básicos (não travam se vier nulo)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_anuncios_estrategicos_prices_nonneg'
  ) THEN
    ALTER TABLE anuncios_estrategicos
      ADD CONSTRAINT ck_anuncios_estrategicos_prices_nonneg
      CHECK (
        (original_price IS NULL OR original_price >= 0)
        AND (promo_price IS NULL OR promo_price >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_anuncios_estrategicos_percent_range'
  ) THEN
    ALTER TABLE anuncios_estrategicos
      ADD CONSTRAINT ck_anuncios_estrategicos_percent_range
      CHECK (
        (percent_default IS NULL OR (percent_default >= 0 AND percent_default <= 90))
        AND (percent_applied IS NULL OR (percent_applied >= 0 AND percent_applied <= 99.99))
      );
  END IF;
END $$;

COMMIT;
