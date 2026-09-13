BEGIN;

CREATE TABLE IF NOT EXISTS ml.notificacoes (
  id bigserial PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES ml.usuarios(id) ON DELETE CASCADE,
  empresa_id bigint REFERENCES ml.empresas(id) ON DELETE CASCADE,
  meli_conta_id bigint NOT NULL REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  data_referencia date NOT NULL,
  titulo text NOT NULL,
  mensagem text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  lida_em timestamptz,
  criada_em timestamptz NOT NULL DEFAULT now(),
  atualizada_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_notificacoes_usuario_conta_tipo_data
  ON ml.notificacoes (usuario_id, meli_conta_id, tipo, data_referencia);

CREATE INDEX IF NOT EXISTS notificacoes_usuario_conta_data_idx
  ON ml.notificacoes (usuario_id, meli_conta_id, data_referencia DESC, criada_em DESC);

CREATE INDEX IF NOT EXISTS notificacoes_lida_em_idx
  ON ml.notificacoes (lida_em);

COMMIT;
