BEGIN;

ALTER TABLE anuncios_full
  ADD COLUMN IF NOT EXISTS sold_7d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold_15d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold_30d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_7d_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_15d_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_30d_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coverage_days NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS suggested_restock_30d INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS full_synced_payload JSONB;

CREATE TABLE IF NOT EXISTS full_plans (
  id BIGSERIAL PRIMARY KEY,
  meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
  usuario_id BIGINT REFERENCES usuarios (id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  observacao TEXT,
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  periodo_dias INTEGER NOT NULL DEFAULT 30,
  cobertura_dias INTEGER NOT NULL DEFAULT 30,
  fator_seguranca NUMERIC(8,4) NOT NULL DEFAULT 0,
  total_sugerido INTEGER NOT NULL DEFAULT 0,
  total_valor_cents BIGINT NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_full_plans_conta_updated
  ON full_plans (meli_conta_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS full_plan_items (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES full_plans (id) ON DELETE CASCADE,
  meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
  mlb TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  image_url TEXT,
  price_cents BIGINT NOT NULL DEFAULT 0,
  stock_full INTEGER NOT NULL DEFAULT 0,
  units_sold INTEGER NOT NULL DEFAULT 0,
  revenue_cents BIGINT NOT NULL DEFAULT 0,
  daily_velocity NUMERIC(12,4) NOT NULL DEFAULT 0,
  coverage_days NUMERIC(12,2),
  suggested_restock INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'low',
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_full_plan_items_plan
  ON full_plan_items (plan_id, suggested_restock DESC);

COMMIT;
