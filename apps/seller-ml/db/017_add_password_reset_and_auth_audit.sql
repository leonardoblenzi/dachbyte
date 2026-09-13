BEGIN;

ALTER TABLE ml.usuarios
  ADD COLUMN IF NOT EXISTS reset_token_hash text,
  ADD COLUMN IF NOT EXISTS reset_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reset_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS senha_alterada_em timestamptz;

CREATE INDEX IF NOT EXISTS usuarios_reset_token_hash_idx
  ON ml.usuarios (reset_token_hash)
  WHERE reset_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS ml.auth_audit (
  id bigserial PRIMARY KEY,
  user_id bigint REFERENCES ml.usuarios(id) ON DELETE SET NULL,
  email text,
  evento text NOT NULL,
  status text NOT NULL DEFAULT 'info',
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_audit_created_at_idx
  ON ml.auth_audit (created_at);

CREATE INDEX IF NOT EXISTS auth_audit_user_id_idx
  ON ml.auth_audit (user_id);

CREATE INDEX IF NOT EXISTS auth_audit_evento_idx
  ON ml.auth_audit (evento);

COMMIT;
