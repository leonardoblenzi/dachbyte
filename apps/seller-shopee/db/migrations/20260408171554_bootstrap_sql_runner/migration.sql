-- Migration: 20260408171554_bootstrap_sql_runner
-- Module: shopee
-- Executada manualmente no banco definido em DATABASE_URL

BEGIN;

-- Bootstrap do fluxo de migrations SQL direto no Neon.
-- Nao altera schema.
-- O historico legado do Prisma deve ser importado para `_davantti_sql_migrations`
-- pelo comando `npm run db:migrate:baseline` ou automaticamente antes do deploy.

SELECT 1;

COMMIT;
