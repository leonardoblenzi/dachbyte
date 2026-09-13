ALTER TABLE meli_contas
  DROP CONSTRAINT IF EXISTS meli_contas_status_check;

ALTER TABLE meli_contas
  ADD CONSTRAINT meli_contas_status_check
  CHECK (status IN ('ativa', 'revogada', 'erro', 'desvinculada', 'unlinked', 'revoked'));
