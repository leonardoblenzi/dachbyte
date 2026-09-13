# Shopee

## Banco de dados

O modulo `shopee` agora usa SQL direto no runtime, nas migrations e nos scripts operacionais. Alteracoes no banco devem ser executadas direto no Neon definido em `apps/seller-shopee/src/.env` ou `apps/seller-shopee/.env`.

Scripts disponiveis em `apps/seller-shopee/package.json`:

- `npm run db:migrate:create -- <nome_da_migration>`
- `npm run db:migrate:deploy`
- `npm run db:migrate:status`
- `npm run db:migrate:baseline`
- `npm run db:execute -- <caminho-do-arquivo.sql>`
- `npm run seed:admin`

Fluxo:

- novas migrations ficam em `apps/seller-shopee/db/migrations/<timestamp>_<nome>/migration.sql`
- `db:migrate:deploy` aplica apenas o que ainda nao foi registrado em `_davantti_sql_migrations`
- `db:migrate:baseline` importa o historico legado de `_prisma_migrations` para a nova tabela de controle, sem usar Prisma CLI
- `db:execute` executa SQL avulso direto no `DATABASE_URL` do modulo
- `seed:admin` garante a conta `Legacy`, faz o backfill de `Shop.accountId` nulo e sobe o usuario master direto via SQL

## Estrutura relevante

```text
shopee
|-- db
|   |-- legacy-migrations
|   |-- migrations
|-- docs
|-- public
|-- scripts
|   |-- db-migrate.js
|   `-- seed-admin.js
`-- src
    |-- config
    |-- controllers
    |-- jobs
    |-- middlewares
    |-- repositories
    |-- routes
    |-- scripts
    |-- services
    `-- utils
```
