-- 067_create_anuncio_drafts.sql
-- Novo modulo Anuncios > Cadastro. Independente do clonador legado.

CREATE TABLE IF NOT EXISTS ml.anuncio_drafts (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT REFERENCES ml.empresas(id) ON DELETE CASCADE,
  meli_conta_id BIGINT NOT NULL REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
  created_by BIGINT REFERENCES ml.usuarios(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES ml.usuarios(id) ON DELETE SET NULL,

  source_type TEXT NOT NULL DEFAULT 'blank',
  source_item_id TEXT,
  source_user_product_id TEXT,
  source_family_id TEXT,
  source_seller_id BIGINT,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference_data JSONB NOT NULL DEFAULT '{}'::jsonb,

  publication_model TEXT NOT NULL DEFAULT 'legacy',
  category_id TEXT,
  family_name TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'incomplete',

  draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  validation_hash TEXT,
  validation_data JSONB,
  validated_at TIMESTAMPTZ,

  published_item_id TEXT,
  published_user_product_id TEXT,
  published_family_id TEXT,
  published_permalink TEXT,
  published_at TIMESTAMPTZ,
  last_publish_result JSONB,

  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_scope
  ON ml.anuncio_drafts (meli_conta_id, deleted_at, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_source_item
  ON ml.anuncio_drafts (source_item_id);

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_family
  ON ml.anuncio_drafts (source_family_id, meli_conta_id);

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_published
  ON ml.anuncio_drafts (published_item_id)
  WHERE published_item_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anuncio_drafts_source_type_check'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_source_type_check
      CHECK (source_type IN ('blank', 'own_item', 'own_family', 'external_item', 'draft_copy'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anuncio_drafts_publication_model_check'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_publication_model_check
      CHECK (publication_model IN ('legacy', 'user_products'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anuncio_drafts_status_check'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_status_check
      CHECK (status IN ('incomplete', 'review', 'error', 'ready', 'publishing', 'published', 'publish_error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anuncio_drafts_validation_status_check'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_validation_status_check
      CHECK (validation_status IN ('pending', 'valid', 'invalid', 'error'));
  END IF;
END $$;
