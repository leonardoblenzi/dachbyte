-- Ledger independente para registrar e auditar a migração/rotina de
-- particionamento. A tabela auth_audit ativa não é tocada nesta migration.
CREATE TABLE IF NOT EXISTS ml.auth_audit_partition_operations (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  kind text NOT NULL,
  status text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_audit_partition_operations_kind_check
    CHECK (kind IN ('preflight', 'copy', 'validate', 'swap', 'rollback', 'maintenance')),
  CONSTRAINT auth_audit_partition_operations_status_check
    CHECK (status IN ('started', 'completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS auth_audit_partition_operations_created_at_idx
  ON ml.auth_audit_partition_operations (created_at DESC);
