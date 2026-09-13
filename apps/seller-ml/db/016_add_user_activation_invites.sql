BEGIN;

ALTER TABLE ml.usuarios
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativo',
  ADD COLUMN IF NOT EXISTS activation_token_hash text,
  ADD COLUMN IF NOT EXISTS activation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS activation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

UPDATE ml.usuarios
   SET status = 'ativo'
 WHERE status IS NULL;

ALTER TABLE ml.usuarios
  DROP CONSTRAINT IF EXISTS usuarios_status_check;

ALTER TABLE ml.usuarios
  ADD CONSTRAINT usuarios_status_check
  CHECK (status IN ('pendente_ativacao', 'ativo', 'inativo'));

CREATE INDEX IF NOT EXISTS usuarios_activation_token_hash_idx
  ON ml.usuarios (activation_token_hash)
  WHERE activation_token_hash IS NOT NULL;

COMMIT;
