-- db/00Y_add_metrics_full_40d.sql
-- FULL • adiciona métricas 40d (impressões / cliques)

BEGIN;

ALTER TABLE anuncios_full
  ADD COLUMN IF NOT EXISTS impressions_40d INTEGER NOT NULL DEFAULT 0;

ALTER TABLE anuncios_full
  ADD COLUMN IF NOT EXISTS clicks_40d INTEGER NOT NULL DEFAULT 0;

-- Checks básicos (não negativos)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_anuncios_full_metrics_nonneg'
  ) THEN
    ALTER TABLE anuncios_full
      ADD CONSTRAINT ck_anuncios_full_metrics_nonneg
      CHECK (
        impressions_40d >= 0
        AND clicks_40d >= 0
      );
  END IF;
END $$;

COMMIT;
