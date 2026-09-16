# Business databases: Neon -> PostgreSQL local da VPS

Este fluxo cobre apenas os bancos do Business: Chat, Core, Stock e Price.
O objetivo e migrar os dados do Neon para o servico `postgres` do `compose.vps.yml` sem permitir migrations automaticas no startup.

## Topologia local

- Chat: database `dachbyte_chat`, runtime/owner `dachbyte_chat_app`.
- Core: database `dachbyte_core`, migrations via `dachbyte_admin`, runtime `dachbyte_core_app` NOBYPASSRLS.
- Stock: database `dachbyte_stock`, owner/migration `dachbyte_stock_migrator`, runtime `dachbyte_stock_app` NOBYPASSRLS.
- Price: database `dachbyte_price`, owner/migration `dachbyte_price_migrator`, runtime `dachbyte_price_app` NOBYPASSRLS.

As roles runtime nao devem receber `SUPERUSER` nem `BYPASSRLS`.

## 1. Criar os arquivos privados

Copie os exemplos e preencha secrets reais:

```bash
cd infra
cp env/compose.env.example env/compose.env
cp env/postgres.env.example env/postgres.env
cp env/business-chat-api.env.example env/business-chat-api.env
cp env/business-chat.env.example env/business-chat.env
cp env/business-core.env.example env/business-core.env
cp env/business-core-migrate.env.example env/business-core-migrate.env
cp env/business-stock.env.example env/business-stock.env
cp env/business-stock-migrate.env.example env/business-stock-migrate.env
cp env/business-price.env.example env/business-price.env
cp env/business-price-migrate.env.example env/business-price-migrate.env
cp env/migration.env.example env/migration.env
```

Mantenha os `.env` fora do Git. As senhas de role em `postgres.env` devem ser as mesmas usadas nas URLs correspondentes dos demais arquivos. Prefira senhas URL-safe (por exemplo hex/base64url sem `@:/?#`) ou aplique percent-encoding nas connection strings.

## 2. Provisionar PostgreSQL local

```bash
./business-db-ops.sh provision
```

O provisionamento e idempotente: cria bancos/roles quando faltam e reaplica os passwords/atributos seguros quando ja existem. O mesmo script tambem fica montado em `docker-entrypoint-initdb.d` para um volume PostgreSQL totalmente novo.

## 3. Preparar o import

Em `env/migration.env`, preencha as quatro URLs fonte do Neon usando endpoints diretos para `pg_dump` e as URLs locais de destino.

Antes do import, deixe:

```env
CONFIRM_BUSINESS_DB_IMPORT=YES
ALLOW_NONEMPTY_TARGET=NO
```

O import recusa bancos locais nao vazios. Isso evita misturar acidentalmente dados novos com o dump do Neon.

## 4. Dump e restore

Coloque os produtos em manutencao ou interrompa escrita no Neon no momento do corte. Depois:

```bash
./business-db-ops.sh import
```

O comando primeiro gera e valida os quatro dumps. Somente depois verifica que todos os destinos estao vazios e inicia o restore. Os dumps e `SHA256SUMS` ficam em `infra/backups/migration/neon-import-<timestamp>/`.

Nao remova esses dumps ate o go-live estar validado.

## 5. Migrations explicitas

```bash
./business-db-ops.sh migrate
```

Antes de executar qualquer migration, este comando cria outro snapshot dos quatro bancos locais em `infra/backups/migration/pre-migrate-<timestamp>/`.

Depois executa, nesta ordem:

1. Chat (`scripts/deploy_db.py`)
2. Core (`npm run migrate`)
3. Stock (`npm run db:migrate`)
4. Price (`db/migrate.js`)

`AUTO_MIGRATE_DB` do Chat permanece `false`.

## 6. Verificar roles e schemas

```bash
./business-db-ops.sh verify
```

A verificacao confirma que as quatro URLs runtime conectam, que as roles runtime nao sao `SUPERUSER/BYPASSRLS` e que as tabelas de controle de migrations existem.

Depois disso, a validacao funcional da aplicacao pertence a etapa de staging: login, multiempresa/RLS, WebSocket, uploads, Hub e integracoes.

## 7. Backup recorrente

O container de backup usa ferramentas PostgreSQL 18, a mesma major version do servidor local. Configure `env/backup.env`, inicialize o repositorio restic uma unica vez e execute:

```bash
./business-db-ops.sh backup
```

O backup inclui todos os databases locais, globals PostgreSQL, uploads do Chat e resultados persistentes do ML. Retencao/prune continuam como operacao separada.

## Rollback do corte

Enquanto o Neon original nao for desativado, o rollback mais simples e reverter as URLs/runtime para o Neon e manter os dumps locais para diagnostico. Nao execute import sobre banco local ja utilizado em producao. Para uma nova tentativa, restaure um volume/banco limpo e repita o procedimento.

## Gate seguinte: staging

Depois de `./business-db-ops.sh verify` e antes de qualquer corte de producao, execute os gates descritos em `STAGING_VALIDATION.md`:

```bash
./business-staging-ops.sh all
```

O cutover nao deve prosseguir enquanto esse comando ou os testes manuais obrigatorios estiverem com falhas.
