# Volt Core

App de controle empresarial da linha Davantti Business.

## Banco e migrations

O runtime real usa Postgres/Neon com duas roles e duas URLs separadas em producao:

```text
VOLT_CORE_APP_DATABASE_URL=postgres direto usando a role exclusiva da aplicacao
VOLT_CORE_DIRECT_DATABASE_URL=postgres direto usando a role administrativa de migrations
```

Nesta implementacao, as duas URLs devem usar o endpoint direto do Neon, sem `-pooler`. O contexto de tenant do RLS e aplicado por sessao, portanto o pooler em modo transacional nao deve ser usado pelo runtime.

A role configurada em `VOLT_CORE_APP_DATABASE_URL` deve ser exclusiva da aplicacao e nao pode possuir `SUPERUSER`, `BYPASSRLS` nem herdar `neon_superuser`. O runtime valida essas restricoes no startup e recusa iniciar com uma role administrativa. `npm run migrate` usa a URL direta administrativa, cria ou endurece a role da aplicacao e concede somente os acessos necessarios ao banco, schema, tabelas e sequences.

Comandos:

```bash
npm --prefix apps/business/core run migrate
npm --prefix apps/business/core run seed:qa
```

Sem banco configurado, o login e as telas operacionais ficam indisponiveis. O Volt Core nao cria usuarios, empresas ou registros ficticios como fallback.

No Render, o `preDeployCommand` executa `npm run preflight` e `npm run migrate`. O `npm start` apenas inicia o servico; alteracoes de schema devem continuar em uma etapa explicita de pre-deploy. O seed de QA e manual e deve ser usado apenas em staging/homologacao. Variaveis aceitas pelo seed:

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

Antes de producao, execute tambem:

```bash
npm run preflight
npm test
npm run migrate
npm run build
```

Os registros de QA e observacoes de casos legados ficam em `docs/` e devem ser preservados como historico operacional.

## Autenticacao e admin master

O master inicial pode ser provisionado no startup pelas variaveis globais do Render:

```text
VOLT_CORE_JWT_SECRET=segredo forte
VOLT_CORE_BOOTSTRAP_MASTER_ENABLED=true
VOLT_CORE_BOOTSTRAP_MASTER_EMAIL=...
VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD=...
```

Tambem e aceito `VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD_HASH`. Quando o Hub estiver configurado, o Volt Core usa `HUB_BASE_URL`, `HUB_INTERNAL_TOKEN` e `HUB_LOGIN_MODE` para login e provisionamento global. Com `HUB_LOGIN_MODE=fallback`, `mirror` ou `strict`, usuarios comuns sempre precisam ser autenticados pelo Hub com permissao para o modulo `volt_core`; o master continua com autenticacao local.

O provisionamento e sob demanda: nenhuma empresa, usuario ou vinculo e criado apenas por existir no Hub. A sincronizacao acontece dentro do primeiro login autorizado no Volt Core. O primeiro usuario autorizado de um tenant novo recebe o papel de admin da empresa; os seguintes entram como operadores. Papeis e permissoes ja configurados no Volt Core sao preservados nos proximos logins. Se o Hub nao enviar nome ou documento da empresa, o primeiro admin confirma o cadastro antes de escolher o setor.

O isolamento por empresa e o RBAC sao obrigatorios em todas as rotas operacionais. Leituras e escritas consultam o vinculo persistido da empresa, com os perfis `owner`, `manager`, `operator`, `stock` e `finance`, alem de permissoes explicitas e overrides por usuario.

O runtime persistente tambem aplica permissoes por acao nas rotas `/api/core/runtime/...`. O admin master Davantti tem acesso total. O admin da empresa controla usuarios da propria conta, telas visiveis e permissoes de escrita/leitura por modulo. As permissoes e telas ficam no vinculo `volt_core.user_companies`, permitindo que um usuario tenha acesso diferente em empresas diferentes.

## Deploy no Render

O blueprint standalone esta em `apps/business/core/render.yaml`. Ele executa build, migration via URL direta e inicia o servidor Express que serve o frontend compilado. As URLs e segredos permanecem `sync: false` para serem fornecidos pelo ambiente do Render.

Quando o Volt Core roda dentro do webservice compartilhado `business`, use `node start.js` como **Start Command**. Esse entrypoint inicia os modulos do agregador e fixa explicitamente o subprocesso Uvicorn do Volt Chat em um unico worker (`--workers 1`), evitando que `WEB_CONCURRENCY` multiplique processos Python, pools e estado WebSocket. Mantenha tambem:

```text
WEB_CONCURRENCY=1
```

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

O Volt Core esta preparado para rodar futuramente dentro do dominio da Volt Corp com tres camadas:

```text
/core      -> landing publica do produto
/core/app  -> app logado do cliente
/api/core  -> API consumida pelo app
```

Dominio principal e rotas publicas:

```text
https://www.voltcorporation.com.br/                 -> landing institucional futura da Volt Corporation
https://www.voltcorporation.com.br/core             -> landing publica do Volt Core
https://www.voltcorporation.com.br/core/app         -> app logado do Volt Core
https://www.voltcorporation.com.br/core/app/dashboard
https://www.voltcorporation.com.br/api/core/auth/login
https://www.voltcorporation.com.br/api/core/runtime/companies/:companyId/workspace
```

O dominio raiz `voltcorporation.com.br` deve redirecionar permanentemente para `www.voltcorporation.com.br`. Enquanto a landing institucional nao for criada, a raiz `/` permanece reservada; o produto deve ser divulgado pela URL `/core`.

A API publica usa exclusivamente `/api/core/...`, evitando conflito com a landing `/core` e o app `/core/app`. O app React normaliza chamadas antigas internas para `/api/core/...` por padrao. Para mudar a base sem alterar codigo, use:

```text
VOLT_CORE_APP_BASE_PATH=/core/app
VITE_VOLT_CORE_API_BASE=/api/core
```

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
GET  /api/core/runtime/companies
POST /api/core/runtime/companies                         -> master
GET  /api/core/runtime/companies/:companyId/workspace
POST /api/core/runtime/companies/:companyId/apply-segment -> master
PATCH /api/core/runtime/companies/:companyId/configuration/overrides -> master

POST/PATCH/DELETE /api/core/runtime/companies/:companyId/customers/...
POST/PATCH/DELETE /api/core/runtime/companies/:companyId/products/...
POST              /api/core/runtime/companies/:companyId/inventory/movements
POST               /api/core/runtime/companies/:companyId/sales
POST               /api/core/runtime/companies/:companyId/sales/:saleId/cancel
POST               /api/core/runtime/companies/:companyId/cash/...
POST               /api/core/runtime/companies/:companyId/receivables/...
POST/PATCH          /api/core/runtime/companies/:companyId/service-orders/...
POST/PATCH          /api/core/runtime/companies/:companyId/prescriptions/...
POST/PATCH          /api/core/runtime/companies/:companyId/optical-...
POST/PATCH          /api/core/runtime/companies/:companyId/fiscal-documents/...
POST/PATCH          /api/core/runtime/companies/:companyId/users/...
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
