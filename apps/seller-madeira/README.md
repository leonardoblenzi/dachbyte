# MadeiraMadeira

Base do modulo MadeiraMadeira para a `davanttiSuite`.

## O que ja existe

- app Express montado em `/madeiramadeira`
- login e painel visual do modulo
- cliente HTTP preparado para `TOKENMM`
- migrations SQL para Neon/Postgres
- endpoints de status para banco, dashboard e referencia tecnica

## Variaveis de ambiente

Copie `apps/seller-madeira/.env.example` para `apps/seller-madeira/.env` e preencha:

- `MADEIRA_ENV`: `sandbox` ou `production`
- `MADEIRA_API_BASE_URL`: opcional, sobrescreve a URL padrao do ambiente
- `MADEIRA_API_TOKEN`: token do seller para a API principal
- `MADEIRA_MESSAGING_BASE_URL`: base da API de mensageria
- `MADEIRA_MESSAGING_BEARER_TOKEN`: token JWT/Keycloak da mensageria
- `MADEIRA_MESSAGING_MM_TOKEN`: token adicional `MMTOKEN`/`HTTP_MMTOKEN`
- `MAD_DATABASE_URL`: conexao Postgres do Neon
- `MAD_DIRECT_DATABASE_URL`: opcional, URL direta do Neon para migrations
- `MADEIRA_REQUEST_TIMEOUT_MS`: timeout das chamadas HTTP

## Banco de dados

O modulo `MadeiraMadeira` nao usa mais Prisma em runtime nem para migrations/deploy. O acesso ao banco e feito direto via `pg`, e as migrations sao SQL puro no Neon.

Novas migrations devem ser criadas em `apps/seller-madeira/db/migrations/<timestamp>_<nome>/migration.sql` e executadas direto no banco configurado no `.env` do modulo.

O schema Prisma legado foi removido do codigo do modulo. O historico SQL antigo permanece apenas em
`apps/seller-madeira/prisma/migrations` para permitir baseline de bancos que ainda tenham `_prisma_migrations`.

Scripts disponiveis em `apps/seller-madeira/package.json`:

- `npm run db:migrate:create -- <nome_da_migration>`
- `npm run db:migrate:deploy`
- `npm run db:migrate:status`
- `npm run db:migrate:baseline`
- `npm run db:execute -- <caminho-do-arquivo.sql>`
- `npm run seed:admin`

Observacoes:
- `db:migrate:deploy` usa `MAD_DIRECT_DATABASE_URL` quando existir e cai para `MAD_DATABASE_URL` como fallback.
- `db:migrate:baseline` importa para o historico novo as migrations que ja constam em `_prisma_migrations`, evitando reaplicar o legado do Prisma.
- `db:execute` roda qualquer arquivo SQL direto no banco do modulo sem registrar migration.

Para subir ou atualizar o admin master inicial no banco, rode `npm run seed:admin`.

## Endpoints disponiveis

- `GET /madeiramadeira/login`
- `GET /madeiramadeira/painel`
- `GET /madeiramadeira/referencia`
- `GET /madeiramadeira/status`
- `GET /madeiramadeira/api/health`
- `GET /madeiramadeira/api/config`
- `GET /madeiramadeira/api/reference`
- `POST /madeiramadeira/api/auth/login`
- `GET /madeiramadeira/api/database/status`
- `GET /madeiramadeira/api/dashboard/overview`
- `GET /madeiramadeira/api/catalog/categories`
- `POST /madeiramadeira/api/catalog/products`
- `GET /madeiramadeira/api/messaging/awaiting-answer-count`
- `GET /madeiramadeira/api/messaging/orders-history`
- `POST /madeiramadeira/api/messaging/revoke-token`
- `POST /madeiramadeira/api/freight/quote/validate`

## Proximos passos sugeridos

1. aplicar migrations SQL com `npm run db:migrate:deploy`
2. validar sandbox com `categories`
3. mapear transformacao de produto Davantti -> payload MadeiraMadeira
4. implementar sincronizacao real de pedidos, financeiro e callbacks
