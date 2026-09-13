BEGIN;

CREATE TABLE IF NOT EXISTS ml.auth_audit_retention_rules (
  evento text PRIMARY KEY,
  descricao text,
  retention_days integer NOT NULL CHECK (retention_days > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ml.auth_audit_retention_rules (evento, descricao, retention_days)
VALUES
  ('*', 'Padrao para eventos sem regra especifica', 90),
  ('login_success', 'Login concluido com sucesso', 90),
  ('login_failed', 'Falha de login por credencial invalida', 120),
  ('login_blocked', 'Tentativa barrada por status ou politica', 180),
  ('password_reset_requested', 'Solicitacao de redefinicao de senha', 180),
  ('password_reset_email', 'Resultado do envio do email de reset', 180),
  ('password_reset_completed', 'Conclusao ou falha do reset de senha', 365),
  ('invite_activated', 'Conta ativada por convite', 365),
  ('admin_audit_cleanup', 'Execucao manual da limpeza de auditoria', 365),
  ('admin_audit_retention_updated', 'Edicao das regras de retencao', 365)
ON CONFLICT (evento) DO NOTHING;

COMMIT;
