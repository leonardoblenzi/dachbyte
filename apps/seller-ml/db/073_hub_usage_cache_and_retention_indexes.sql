CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.hub_usage_report_cache (
  usage_date date PRIMARY KEY,
  reports jsonb NOT NULL DEFAULT '[]'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_hub_usage_report_cache_collected_at
  ON ml.hub_usage_report_cache (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_snapshot_date
  ON ml.reputation_snapshots (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_ml_sku_sync_runs_created
  ON ml.mercadolivre_sku_sync_runs (created_at DESC);

DO $$
BEGIN
  IF to_regclass('ml.ml_ranking_anuncios_snapshots') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_ml_ranking_snapshots_periodo_fim ON ml.ml_ranking_anuncios_snapshots (periodo_fim DESC)';
  ELSIF to_regclass('public.ml_ranking_anuncios_snapshots') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_ml_ranking_snapshots_periodo_fim ON public.ml_ranking_anuncios_snapshots (periodo_fim DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('ml.ml_stock_watch_events') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_ml_stock_watch_events_created ON ml.ml_stock_watch_events (created_at DESC)';
  ELSIF to_regclass('public.ml_stock_watch_events') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_ml_stock_watch_events_created ON public.ml_stock_watch_events (created_at DESC)';
  END IF;
END $$;
