-- 068_anuncio_drafts_publication_target.sql
-- Separa explicitamente criação de novo item/UP de nova condição de venda.

ALTER TABLE ml.anuncio_drafts
  ADD COLUMN IF NOT EXISTS publication_target TEXT;

UPDATE ml.anuncio_drafts
   SET publication_target = CASE
     WHEN source_type = 'own_family' AND source_user_product_id IS NOT NULL THEN 'sale_condition'
     ELSE 'new_item'
   END
 WHERE publication_target IS NULL;

ALTER TABLE ml.anuncio_drafts
  ALTER COLUMN publication_target SET DEFAULT 'new_item';

ALTER TABLE ml.anuncio_drafts
  ALTER COLUMN publication_target SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anuncio_drafts_publication_target_check'
  ) THEN
    ALTER TABLE ml.anuncio_drafts
      ADD CONSTRAINT anuncio_drafts_publication_target_check
      CHECK (publication_target IN ('new_item', 'sale_condition'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anuncio_drafts_publication_target
  ON ml.anuncio_drafts (meli_conta_id, publication_target, status, updated_at DESC)
  WHERE deleted_at IS NULL;
