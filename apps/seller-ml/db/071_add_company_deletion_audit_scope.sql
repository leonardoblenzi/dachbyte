ALTER TABLE ml.auth_audit
  ADD COLUMN IF NOT EXISTS empresa_id bigint,
  ADD COLUMN IF NOT EXISTS meli_conta_id bigint;

-- Relaciona somente IDs numéricos que existam de fato. A conta é a fonte
-- prioritária da empresa, pois ela já pertence a uma única empresa.
-- Em bases grandes, aplicar esta migration em janela de manutenção após backup:
-- o backfill e os índices usuais são executados na transação do migration runner.
WITH normalized_values AS (
  SELECT
    a.id,
    CASE
      WHEN a.metadata ->> 'meli_conta_id' ~ '^[0-9]+$'
        THEN COALESCE(NULLIF(ltrim(a.metadata ->> 'meli_conta_id', '0'), ''), '0')
    END AS meli_conta_digits
  FROM ml.auth_audit a
  WHERE a.meli_conta_id IS NULL
),
valid_values AS (
  SELECT
    id,
    CASE
      WHEN meli_conta_digits IS NOT NULL
        AND (
          char_length(meli_conta_digits) < 19
          OR (
            char_length(meli_conta_digits) = 19
            AND meli_conta_digits <= '9223372036854775807'
          )
        )
        THEN meli_conta_digits::bigint
    END AS meli_conta_id
  FROM normalized_values
)
UPDATE ml.auth_audit a
SET
  meli_conta_id = mc.id,
  empresa_id = mc.empresa_id
FROM valid_values v
JOIN ml.meli_contas mc ON mc.id = v.meli_conta_id
WHERE a.id = v.id;

-- Para eventos sem conta vinculada, usa somente identificadores de empresa
-- numéricos que apontem para uma empresa ainda existente.
WITH normalized_values AS (
  SELECT
    a.id,
    CASE
      WHEN a.metadata ->> 'empresa_id' ~ '^[0-9]+$'
        THEN COALESCE(NULLIF(ltrim(a.metadata ->> 'empresa_id', '0'), ''), '0')
    END AS empresa_digits,
    CASE
      WHEN a.metadata ->> 'company_id' ~ '^[0-9]+$'
        THEN COALESCE(NULLIF(ltrim(a.metadata ->> 'company_id', '0'), ''), '0')
    END AS company_digits
  FROM ml.auth_audit a
  WHERE a.meli_conta_id IS NULL
    AND a.empresa_id IS NULL
),
valid_values AS (
  SELECT
    id,
    CASE
      WHEN empresa_digits IS NOT NULL
        AND (
          char_length(empresa_digits) < 19
          OR (
            char_length(empresa_digits) = 19
            AND empresa_digits <= '9223372036854775807'
          )
        )
        THEN empresa_digits::bigint
    END AS empresa_id,
    CASE
      WHEN company_digits IS NOT NULL
        AND (
          char_length(company_digits) < 19
          OR (
            char_length(company_digits) = 19
            AND company_digits <= '9223372036854775807'
          )
        )
        THEN company_digits::bigint
    END AS company_id
  FROM normalized_values
)
UPDATE ml.auth_audit a
SET empresa_id = e.id
FROM valid_values v
JOIN ml.empresas e ON e.id = COALESCE(v.empresa_id, v.company_id)
WHERE a.id = v.id;

-- Corrige eventos cujo vínculo de conta já existia: a empresa da conta sempre
-- prevalece sobre qualquer valor anterior da auditoria.
UPDATE ml.auth_audit a
SET empresa_id = mc.empresa_id
FROM ml.meli_contas mc
WHERE a.meli_conta_id IS NOT NULL
  AND mc.id = a.meli_conta_id
  AND a.empresa_id IS DISTINCT FROM mc.empresa_id;

DO $$
DECLARE
  empresa_fk_is_correct boolean;
  conta_fk_is_correct boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'auth_audit_empresa_id_fkey'
      AND c.conrelid = 'ml.auth_audit'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'ml.auth_audit'::regclass
           AND attname = 'empresa_id'
           AND NOT attisdropped)
      ]::smallint[]
      AND c.confrelid = 'ml.empresas'::regclass
      AND c.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'ml.empresas'::regclass
           AND attname = 'id'
           AND NOT attisdropped)
      ]::smallint[]
      AND c.confdeltype = 'c'
  ) INTO empresa_fk_is_correct;

  IF NOT empresa_fk_is_correct THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'auth_audit_empresa_id_fkey'
        AND conrelid = 'ml.auth_audit'::regclass
    ) THEN
      ALTER TABLE ml.auth_audit
        DROP CONSTRAINT auth_audit_empresa_id_fkey;
    END IF;

    ALTER TABLE ml.auth_audit
      ADD CONSTRAINT auth_audit_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES ml.empresas(id) ON DELETE CASCADE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'auth_audit_meli_conta_id_fkey'
      AND c.conrelid = 'ml.auth_audit'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'ml.auth_audit'::regclass
           AND attname = 'meli_conta_id'
           AND NOT attisdropped)
      ]::smallint[]
      AND c.confrelid = 'ml.meli_contas'::regclass
      AND c.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'ml.meli_contas'::regclass
           AND attname = 'id'
           AND NOT attisdropped)
      ]::smallint[]
      AND c.confdeltype = 'c'
  ) INTO conta_fk_is_correct;

  IF NOT conta_fk_is_correct THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'auth_audit_meli_conta_id_fkey'
        AND conrelid = 'ml.auth_audit'::regclass
    ) THEN
      ALTER TABLE ml.auth_audit
        DROP CONSTRAINT auth_audit_meli_conta_id_fkey;
    END IF;

    ALTER TABLE ml.auth_audit
      ADD CONSTRAINT auth_audit_meli_conta_id_fkey
      FOREIGN KEY (meli_conta_id) REFERENCES ml.meli_contas(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS auth_audit_empresa_created_at_idx
  ON ml.auth_audit (empresa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_audit_meli_conta_created_at_idx
  ON ml.auth_audit (meli_conta_id, created_at DESC);

-- Este recibo não tem FK para a empresa: ele permanece após a remoção em
-- cascata e guarda apenas a prova mínima operacional, sem dados de sessão.
CREATE TABLE IF NOT EXISTS ml.company_deletion_receipts (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  deleted_empresa_id bigint NOT NULL,
  empresa_nome text,
  actor_user_id bigint,
  actor_email text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  users_deleted_count integer NOT NULL DEFAULT 0,
  users_unlinked_count integer NOT NULL DEFAULT 0,
  accounts_deleted_count integer NOT NULL DEFAULT 0,
  audit_events_deleted_count bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed',
  CONSTRAINT company_deletion_receipts_users_deleted_nonnegative
    CHECK (users_deleted_count >= 0),
  CONSTRAINT company_deletion_receipts_users_unlinked_nonnegative
    CHECK (users_unlinked_count >= 0),
  CONSTRAINT company_deletion_receipts_accounts_deleted_nonnegative
    CHECK (accounts_deleted_count >= 0),
  CONSTRAINT company_deletion_receipts_audit_events_deleted_nonnegative
    CHECK (audit_events_deleted_count >= 0),
  CONSTRAINT company_deletion_receipts_status_check
    CHECK (status IN ('completed', 'failed'))
);
