# Volt Core

App de controle empresarial da linha Davantti Business.

## Banco e migrations

O runtime de producao usa PostgreSQL local na VPS com duas roles e duas URLs separadas:

```text
VOLT_CORE_APP_DATABASE_URL=postgresql://<role_runtime>@postgres:5432/dachbyte_core
VOLT_CORE_DIRECT_DATABASE_URL=postgresql://<role_migration>@postgres:5432/dachbyte_core
```

A role configurada em `VOLT_CORE_APP_DATABASE_URL` e exclusiva da aplicacao e nao pode possuir `SUPERUSER` nem `BYPASSRLS`. O runtime valida essas restricoes no startup e recusa iniciar com uma role administrativa. A URL `VOLT_CORE_DIRECT_DATABASE_URL` pertence somente ao job one-shot de migration/administracao e nao deve ficar exposta ao container web persistente.

Comandos:

```bash
npm --prefix apps/business/core run migrate
npm --prefix apps/business/core run seed:qa
```

Sem banco configurado, o login e as telas operacionais ficam indisponiveis. O Volt Core nao cria usuarios, empresas ou registros ficticios como fallback.

Na VPS, migrations sao executadas explicitamente pelo fluxo de banco em `infra/business-db-ops.sh`; o `npm start` apenas inicia o servico. O seed de QA e manual e deve ser usado apenas em staging/homologacao. Variaveis aceitas pelo seed:

```text
VOLT_CORE_QA_EMAIL=qa@voltcore.local
VOLT_CORE_QA_PASSWORD=senha forte
VOLT_CORE_QA_COMPANY=Empresa QA Volt Core
```

Migrations de fundacao pre-go-live:

```text
011_platform_foundation.sql -> idempotencia segura de vendas e indices operacionais
012_tenant_integrity.sql    -> defesa adicional de integridade por empresa
013_cash_session_hardening.sql -> endurecimento das sessoes e movimentos de caixa
014_platform_engine_rls.sql -> ativa e forca RLS nas tabelas multi-tenant
019_stock_reservations.sql -> reserva estoque de vendas com entrega futura sem baixar o saldo fisico
```

Antes de producao, valide o produto e execute a migration pela infraestrutura:

```bash
npm run preflight
npm test
npm run build
cd ../../../infra
./business-db-ops.sh migrate
./business-db-ops.sh verify
```

Os registros de QA e observacoes de casos legados ficam em `docs/` e devem ser preservados como historico operacional.

## Autenticacao e admin master

O master inicial pode ser provisionado temporariamente pelas variaveis de ambiente do Core:

```text
VOLT_CORE_JWT_SECRET=segredo forte
VOLT_CORE_BOOTSTRAP_MASTER_ENABLED=true
VOLT_CORE_BOOTSTRAP_MASTER_EMAIL=...
VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD=...
```

Tambem e aceito `VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD_HASH`. Depois do primeiro provisionamento, mantenha obrigatoriamente `VOLT_CORE_BOOTSTRAP_MASTER_ENABLED=false`; o bootstrap e create-only e nao deve fazer parte do ciclo normal de startup. Quando o Hub estiver configurado, o Volt Core usa `HUB_BASE_URL`, `HUB_INTERNAL_TOKEN` e `HUB_LOGIN_MODE` para login e provisionamento global. Com `HUB_LOGIN_MODE=fallback`, `mirror` ou `strict`, usuarios comuns sempre precisam ser autenticados pelo Hub com permissao para o modulo `volt_core`; o master continua com autenticacao local.

O provisionamento e sob demanda: nenhuma empresa, usuario ou vinculo e criado apenas por existir no Hub. A sincronizacao acontece dentro do primeiro login autorizado no Volt Core. O primeiro usuario autorizado de um tenant novo recebe o papel de admin da empresa; os seguintes entram como operadores. Papeis e permissoes ja configurados no Volt Core sao preservados nos proximos logins. Se o Hub nao enviar nome ou documento da empresa, o primeiro admin confirma o cadastro antes de escolher o setor.

O isolamento por empresa e o RBAC sao obrigatorios em todas as rotas operacionais. Leituras e escritas consultam o vinculo persistido da empresa, com os perfis `owner`, `manager`, `operator`, `stock` e `finance`, alem de permissoes explicitas e overrides por usuario.

O runtime persistente tambem aplica permissoes por acao nas rotas `/business/core/api/runtime/...`. O admin master Davantti tem acesso total. O admin da empresa controla usuarios da propria conta, telas visiveis e permissoes de escrita/leitura por modulo. As permissoes e telas ficam no vinculo `volt_core.user_companies`, permitindo que um usuario tenha acesso diferente em empresas diferentes.

## Deploy na VPS

O Core e executado pelo container `business-core` definido em `infra/compose.vps.yml`. Caddy publica os caminhos canonicos `/business/core` e `/business/core/api`. Build, runtime e migrations devem usar os arquivos de ambiente da VPS; credenciais administrativas de banco ficam restritas ao job one-shot de migration.

Fluxo operacional:

```bash
cd infra
./business-db-ops.sh verify
./business-db-ops.sh migrate
./business-staging-ops.sh up     # staging
# ou business-production-ops.sh durante o corte controlado
```

O Core nao inicia subprocessos do Chat e nao depende mais do antigo webservice agregado.

### Worker de integracoes e logs HTTP

O worker de jobs/outbox usa polling adaptativo. Ele consulta em intervalo curto enquanto existe trabalho e aumenta progressivamente a espera quando as filas ficam vazias. Enqueues duraveis controlados pelo proprio store acordam o worker somente depois do commit; o polling no teto ocioso continua sendo a garantia para transacoes externas e trabalho criado por outra instancia.

Configuracao recomendada para producao e staging:

```text
VOLT_CORE_JOB_POLL_MS=3000
VOLT_CORE_WORKER_IDLE_MAX_MS=60000
VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR=2
VOLT_CORE_WORKER_JITTER_RATIO=0.15
VOLT_CORE_HTTP_LOG_MODE=slow-errors
```

- `VOLT_CORE_JOB_POLL_MS`: intervalo ativo e intervalo usado novamente depois de trabalho ou erro; aceita 500 a 300000 ms.
- `VOLT_CORE_WORKER_IDLE_MAX_MS`: teto do polling ocioso; aceita do intervalo ativo ate 900000 ms. Se omitido, usa no minimo 60000 ms.
- `VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR`: multiplicador aplicado a cada ciclo vazio; aceita 1 a 10.
- `VOLT_CORE_WORKER_JITTER_RATIO`: variacao aleatoria do intervalo para evitar ciclos sincronizados; aceita 0 a 0,5.
- `VOLT_CORE_HTTP_LOG_MODE`: aceita `all`, `slow-errors`, `errors` ou `off`. O padrao e `slow-errors` em producao e `all` fora de producao. Metricas HTTP continuam sendo coletadas mesmo quando o access log esta reduzido ou desligado.

As configuracoes operacionais existentes permanecem disponiveis:

```text
VOLT_CORE_JOB_BATCH_SIZE=10
VOLT_CORE_OUTBOX_BATCH_SIZE=20
VOLT_CORE_JOB_LEASE_MS=300000
VOLT_CORE_JOB_RECOVERY_MS=60000
VOLT_CORE_INTEGRATION_MAINTENANCE_MS=21600000
```

Recovery e maintenance conservam sua periodicidade propria; o backoff altera apenas a frequencia dos ciclos normais de processamento. Valores numericos presentes e invalidos interrompem o startup com `WORKER_CONFIG_INVALID`, em vez de criarem timers inconsistentes. O comando standalone `npm run worker:integrations` continua disponivel quando o worker precisar ser executado separadamente.

## Rotas publicas e dominio

Rotas publicas canonicas na VPS:

```text
/business/core      -> landing publica do produto
/business/core/app  -> app logado do cliente
/business/core/api  -> API consumida pelo app
```

O frontend e compilado com `VOLT_CORE_PUBLIC_BASE_PATH=/business/core`, `VOLT_CORE_APP_BASE_PATH=/business/core/app` e `VOLT_CORE_API_BASE_PATH=/business/core/api`. O Caddy encaminha essas rotas diretamente para `business-core`.

`/core/*` redireciona com HTTP 308 para a interface canonica. `/api/core/*` continua temporariamente como proxy de compatibilidade para clientes antigos e recebe headers de deprecacao; nao use esse prefixo em novas integracoes.

A URL publicada deve sempre usar `/business/core`; os aliases antigos existem apenas durante a janela descrita em `infra/LEGACY_DEPRECATION.md`.

## Produto operacional

O app inclui:

- auditoria inspirada no painel master do `ml/`: filtros, paginacao, status, detalhes JSON e exportacao CSV;
- busca e paginacao automaticas em tabelas operacionais;
- busca funcional no PDV/catalogo de produtos;
- relatorios de vendas, estoque, financeiro e exportacoes CSV;
- importacao CSV de clientes/produtos pelo app;
- fiscal controlado com status, provedor, ID externo, chave e retorno do provedor;
- onboarding guiado da primeira empresa;
- matriz visual de perfis/permissoes.

## Setores de empresa

O Volt Core tem um template `general`, que e o core padrao sem setor definido, e templates setoriais que adicionam modulos/telas por empresa.

Para testar no navegador:

- `Core padrao`: clientes, produtos, estoque, vendas, caixa, recebiveis, relatorios e configuracoes.
- `Otica`: herda o core e adiciona ordens de servico e receitas opticas.

No banco, a configuracao fica por empresa em `volt_core.company_configurations`, com `segment_key`, `plan_key`, `modules`, `screens`, `settings` e `overrides`. O runtime resolve a composicao efetiva em modulos, telas e capabilities.

## Decisao tecnica inicial

O Volt Core nasce no padrao `shopee/src`: Express + CommonJS, separado em `routes`, `controllers`, `services` e modulos de dominio. Esse formato escala melhor que o padrao mais antigo do `ml/` para um produto com motor de segmentos, modulos ativaveis e painel master.

## Motor principal

O nucleo (`src/modules/core`) define:

- segmentos de empresa, como `optical`;
- modulos funcionais, como clientes, vendas, estoque e ordem de servico;
- telas/menu liberados por segmento;
- permissoes base;
- templates aplicaveis por empresa;
- overrides manuais do painel master.

Regra de produto:

```text
Configuracao final = Segmento + Plano + Ajustes do Master
```

O template `general` e o core padrao do produto. Ele precisa funcionar sozinho para empresas que querem apenas controle de clientes, produtos, estoque, vendas, caixa, recibos e relatorios.

Setores especificos, como `optical`, devem partir desse core e adicionar telas/campos/fluxos sem fazer o core depender do setor.

## Core operacional

A unica API operacional publica e persistente usa o namespace `runtime`. A antiga implementacao operacional em memoria nao e exposta por HTTP.

Contratos principais:

```text
GET  /business/core/api/runtime/companies
POST /business/core/api/runtime/companies                         -> master
GET  /business/core/api/runtime/companies/:companyId/workspace
POST /business/core/api/runtime/companies/:companyId/apply-segment -> master
PATCH /business/core/api/runtime/companies/:companyId/configuration/overrides -> master

POST/PATCH/DELETE /business/core/api/runtime/companies/:companyId/customers/...
POST/PATCH/DELETE /business/core/api/runtime/companies/:companyId/products/...
POST              /business/core/api/runtime/companies/:companyId/inventory/movements
POST               /business/core/api/runtime/companies/:companyId/sales
POST               /business/core/api/runtime/companies/:companyId/sales/:saleId/cancel
POST               /business/core/api/runtime/companies/:companyId/cash/...
POST               /business/core/api/runtime/companies/:companyId/receivables/...
POST/PATCH          /business/core/api/runtime/companies/:companyId/service-orders/...
POST/PATCH          /business/core/api/runtime/companies/:companyId/prescriptions/...
POST/PATCH          /business/core/api/runtime/companies/:companyId/optical-...
POST/PATCH          /business/core/api/runtime/companies/:companyId/fiscal-documents/...
POST/PATCH          /business/core/api/runtime/companies/:companyId/users/...
```

Cada escrita e protegida por acesso a empresa + permissao e, quando aplicavel, capability do modulo. Vendas aceitam `Idempotency-Key` para retry seguro.

Fluxo padrao suportado pelo core:

```text
empresa -> cliente -> produto -> entrada de estoque -> venda -> baixa estoque -> caixa/recebiveis -> recibo -> dashboard/relatorio
```

Regra financeira:

```text
dinheiro, pix, debito e transferencia -> caixa imediato
credito, nota promissoria, cheque e crediario -> contas a receber
recebivel baixado/compensado -> caixa
```

Contratos de UX do core:

- o `workspace` entrega a configuracao efetiva e o snapshot operacional permitido para a sessao;
- o frontend consulta capabilities para fluxos verticais, em vez de usar o segmento como autorizacao;
- recibos continuam sendo gerados pelo fluxo transacional da venda;
- a proxima etapa de escala e substituir partes do workspace por APIs paginadas/lazy-loading.

Garantias do motor:

- vendas, cancelamentos e baixas de recebiveis rodam em transacao, com rollback se algo falhar;
- recebiveis, vendas e sessoes de caixa seguem maquina de estados explicita;
- cancelamento de venda com recebivel ja baixado exige autorizacao explicita e gera estorno rastreavel;
- caixa usa data operacional e timezone da empresa;
- relatorios e listas aceitam filtros por periodo/status/cliente/produto/forma de pagamento;
- acoes sensiveis usam middleware de permissao com revalidacao persistida de acesso e respeito aos modulos efetivos da empresa;
- auditoria guarda ator, entidade, antes/depois, valor e motivo quando disponivel;
- eventos internos (`sale.created`, `stock.moved`, `receivable.received`, `cash.closed` etc.) ficam disponiveis para futura automacao/notificacao.
