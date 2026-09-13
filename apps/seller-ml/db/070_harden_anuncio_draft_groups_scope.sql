-- 070_harden_anuncio_draft_groups_scope.sql
-- Impede que um rascunho de outra empresa/conta seja associado a um grupo.

ALTER TABLE ml.anuncio_draft_groups
  ADD CONSTRAINT anuncio_draft_groups_scope_unique
  UNIQUE (id, empresa_id, meli_conta_id);

ALTER TABLE ml.anuncio_drafts
  DROP CONSTRAINT IF EXISTS anuncio_drafts_group_fk;

ALTER TABLE ml.anuncio_drafts
  ADD CONSTRAINT anuncio_drafts_group_scope_fk
  FOREIGN KEY (draft_group_id, empresa_id, meli_conta_id)
  REFERENCES ml.anuncio_draft_groups (id, empresa_id, meli_conta_id)
  ON DELETE NO ACTION;
