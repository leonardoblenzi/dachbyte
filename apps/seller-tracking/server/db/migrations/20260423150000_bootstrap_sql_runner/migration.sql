-- Migration: 20260423150000_bootstrap_sql_runner
-- Module: avantracking
-- Executada manualmente no banco definido em AVANTRACKING_DATABASE_URL/DATABASE_URL

BEGIN;

-- Bootstrap do fluxo de migrations SQL direto no Postgres.
-- Nao altera schema.
-- O historico legado do Prisma pode ser importado para `_davantti_sql_migrations`
-- pelo comando `npm run db:migrate:baseline` (ou no deploy automatico antes de aplicar pendentes).

SELECT 1;

COMMIT;
