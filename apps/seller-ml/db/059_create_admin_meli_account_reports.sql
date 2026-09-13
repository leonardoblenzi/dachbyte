CREATE TABLE IF NOT EXISTS admin_meli_account_performance_reports (
  id BIGSERIAL PRIMARY KEY,
  meli_conta_id BIGINT NOT NULL REFERENCES meli_contas (id) ON DELETE CASCADE,
  empresa_id BIGINT REFERENCES empresas (id) ON DELETE SET NULL,
  account_label TEXT,
  empresa_nome TEXT,
  meli_user_id BIGINT,
  generated_by_user_id BIGINT,
  generated_by_email TEXT,
  period_from TIMESTAMPTZ NOT NULL,
  period_to TIMESTAMPTZ NOT NULL,
  period_days INTEGER NOT NULL DEFAULT 90,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  xlsx_path TEXT,
  pdf_path TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_admin_meli_reports_account_created
  ON admin_meli_account_performance_reports (meli_conta_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_meli_reports_status
  ON admin_meli_account_performance_reports (status);
