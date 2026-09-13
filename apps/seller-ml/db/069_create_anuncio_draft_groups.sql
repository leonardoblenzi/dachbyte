-- 069_create_anuncio_draft_groups.sql
-- Agrupamento de rascunhos para copias em lote e clonagem de familias User Products.

CREATE TABLE IF NOT EXISTS ml.anuncio_draft_groups (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES ml.empresas(id) ON DELETE CASCADE,
  meli_conta_id BIGINT NOT NULL REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source_draft_id BIGINT REFERENCES ml.anuncio_drafts(id) ON DELETE SET NULL,
  source_item_id TEXT,
  source_user_product_id TEXT,
  source_family_id TEXT,
  source_label TEXT,
  name TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL DEFAULT 1,
  family_blueprint JSONB,
  expected_published_family_id TEXT,
  created_by BIGINT REFERENCES ml.usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ml.anuncio_drafts
  ADD COLUMN IF NOT EXISTS draft_group_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.conname = 'anuncio_draft_groups_type_check' AND n.nspname='ml' AND t.relname='anuncio_draft_groups'
  ) THEN
    ALTER TABLE ml.anuncio_draft_groups
      ADD CONSTRAINT anuncio_draft_groups_type_check
      CHECK (type IN ('batch_copy', 'family_clone'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.conname = 'anuncio_draft_groups_quantity_check' AND n.nspname='ml' AND t.relname='anuncio_draft_groups'
  ) THEN
    ALTER TABLE ml.anuncio_draft_groups
      ADD CONSTRAINT anuncio_draft_groups_quantity_check
      CHECK (requested_quantity BETWEEN 1 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.conname = 'anuncio_drafts_group_fk' AND n.nspname='ml' AND t.relname='anuncio_drafts'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_group_fk
      FOREIGN KEY (draft_group_id)
      REFERENCES ml.anuncio_draft_groups(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anuncio_draft_groups_scope
  ON ml.anuncio_draft_groups (empresa_id, meli_conta_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_anuncio_draft_groups_source
  ON ml.anuncio_draft_groups (source_family_id, source_item_id, source_draft_id);

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_group
  ON ml.anuncio_drafts (empresa_id, meli_conta_id, draft_group_id, updated_at DESC)
  WHERE draft_group_id IS NOT NULL;
