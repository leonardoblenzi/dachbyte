## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`

## Banco de Dados (SQL Direto)

O fluxo de migration/deploy do `avantracking` agora e SQL direto no Postgres, sem `prisma migrate`.

- Migrations ativas: `server/db/migrations`
- Historico legado Prisma: `server/db/legacy-migrations`
- Runner: `server/scripts/db-migrate.js`
- Variaveis de conexao suportadas: `AVANTRACKING_DATABASE_URL` (prioridade) e `DATABASE_URL` (fallback)

Comandos:

- `npm run db:migrate:create -- <nome_da_migration>`
- `npm run db:migrate:deploy`
- `npm run db:migrate:status`
- `npm run db:migrate:baseline`
- `npm run db:execute -- <caminho-do-arquivo.sql>`

Observacao:

- O runtime do modulo ainda usa Prisma Client (`@prisma/client`) para consultas da aplicacao.
- Apenas o fluxo de migrations/deploy foi migrado para SQL direto.
- Scripts manuais antigos baseados em Prisma foram removidos para evitar execucoes acidentais fora do fluxo oficial.
