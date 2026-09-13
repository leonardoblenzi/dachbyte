-- 025_add_global_identity_fields.sql
-- Campos globais para hub de billing/permissoes

ALTER TABLE IF EXISTS ml.empresas
  ADD COLUMN IF NOT EXISTS tenant_global_id TEXT;

ALTER TABLE IF EXISTS ml.empresas
  ADD COLUMN IF NOT EXISTS document_type TEXT;

ALTER TABLE IF EXISTS ml.empresas
  ADD COLUMN IF NOT EXISTS document_number TEXT;

ALTER TABLE IF EXISTS ml.usuarios
  ADD COLUMN IF NOT EXISTS user_global_id TEXT;

UPDATE ml.empresas
SET document_type = UPPER(TRIM(document_type))
WHERE document_type IS NOT NULL;

UPDATE ml.empresas
SET document_number = NULLIF(REGEXP_REPLACE(COALESCE(document_number, ''), '[^0-9]', '', 'g'), '')
WHERE document_number IS NOT NULL;

UPDATE ml.empresas
SET tenant_global_id = (md5(random()::text || clock_timestamp()::text || id::text)::uuid::text)
WHERE tenant_global_id IS NULL;

UPDATE ml.usuarios
SET user_global_id = (md5(random()::text || clock_timestamp()::text || id::text)::uuid::text)
WHERE user_global_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'empresas_document_type_check'
  ) THEN
    ALTER TABLE ml.empresas
      ADD CONSTRAINT empresas_document_type_check
      CHECK (document_type IS NULL OR document_type IN ('CNPJ', 'CPF'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_empresas_tenant_global_id
  ON ml.empresas (tenant_global_id)
  WHERE tenant_global_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_empresas_document
  ON ml.empresas (document_type, document_number)
  WHERE document_type IS NOT NULL
    AND document_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_user_global_id
  ON ml.usuarios (user_global_id)
  WHERE user_global_id IS NOT NULL;
