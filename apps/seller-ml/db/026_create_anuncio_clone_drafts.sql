-- 026_create_anuncio_clone_drafts.sql
-- Rascunhos de clonagem de anuncios (origem concorrente -> revisao interna).

CREATE TABLE IF NOT EXISTS ml.anuncio_clone_drafts (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT,
  meli_conta_id BIGINT,
  created_by BIGINT,
  updated_by BIGINT,
  source_url TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_seller_id BIGINT,
  source_seller_nickname TEXT,
  source_title TEXT,
  source_permalink TEXT,
  status TEXT NOT NULL DEFAULT 'em_revisao',
  review_notes TEXT,
  draft_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_validation JSONB,
  published_item_id TEXT,
  published_permalink TEXT,
  published_at TIMESTAMPTZ,
  last_publish_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anuncio_clone_drafts_scope
  ON ml.anuncio_clone_drafts (meli_conta_id, account_key, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_anuncio_clone_drafts_source_item
  ON ml.anuncio_clone_drafts (source_item_id);

CREATE INDEX IF NOT EXISTS idx_anuncio_clone_drafts_created_by
  ON ml.anuncio_clone_drafts (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_anuncio_clone_drafts_published_item
  ON ml.anuncio_clone_drafts (published_item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'anuncio_clone_drafts_status_check'
  ) THEN
    ALTER TABLE ml.anuncio_clone_drafts
      ADD CONSTRAINT anuncio_clone_drafts_status_check
      CHECK (status IN ('em_revisao', 'pronto_publicar', 'publicado', 'cancelado'));
  END IF;
END $$;
