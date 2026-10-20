# Seller Module Trial and Automatic Contracting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir OAuth antes do e-mail, ativar um único teste ilimitado de sete dias por empresa/módulo e conduzir contratação, pagamento e renovação pela Seleção de plataforma com faixa apurada automaticamente.

**Architecture:** O Hub é autoridade do relógio, do acesso, da faixa comercial e do checkout. Os módulos Seller mantêm OAuth/tokens e apuram pedidos; o gateway e a Seleção de plataforma consomem o estado consolidado. Créditos comprados continuam no ledger, sem consumo durante teste ativo.

**Tech Stack:** TypeScript/Node/Postgres no Hub; Express/Node/Postgres no Seller ML e Shopee; HTML/CSS/JavaScript no painel; testes `node:test` e scripts dos dois repositórios.

---

**Execução:** neste chat, sem agentes e nos checkouts atuais, conforme pedido do usuário. Não fazer deploy, migration ou alterar `infra/env` durante implementação local. Preservar arquivos não rastreados e mudanças não relacionadas. A especificação de autoridade é `docs/superpowers/specs/2026-10-20-seller-seven-day-module-trial-design.md`. A mudança de preços fixos em andamento no Hub permanece separada; não aplicar sua migration como efeito colateral deste plano.

## Mapa de arquivos e responsabilidades

| Responsabilidade | Arquivos |
| --- | --- |
| Direito de teste único e imutável | Hub `sql/066_seller_module_trials.sql`, `src/modules/onboarding/moduleTrial.ts`, teste `tests/onboarding/moduleTrial.test.ts` |
| Admissão de recurso e créditos durante teste | Hub `src/modules/billing/resources/accessPolicy.ts`, `src/modules/billing/credits/service.ts`, `src/modules/billing/internalRoutes.ts`, testes de billing correspondentes |
| Contrato interno de ativação/consulta | Hub `src/modules/portal/internalRoutes.ts`, `src/modules/portal/service.ts`, testes de portal |
| OAuth provisório antes do e-mail | Dach `apps/seller-ml/routes/meliOAuthRoutes.js`, `apps/seller-ml/routes/authRoutes.js`, `apps/seller-ml/db/078_public_seller_onboarding.sql`, serviços pequenos em `apps/seller-ml/services/`; Shopee no controller OAuth/ativação correspondente; CTAs públicos em `apps/gateway/views/seller/landing-mercado-livre.html` e `landing-shopee.html` |
| Pedidos do mês fechado | Dach `apps/seller-ml/routes/accountRoutes.js`, novo serviço de apuração ML; Shopee `apps/seller-shopee/src/controllers/DashboardController.js` ou serviço de agregação já usado nele; testes por marketplace |
| Painel e compra | Dach `apps/seller-ml/views/selecao-plataforma.html`, testes `tests/seller-portal-home.test.js` e `apps/seller-ml/tests/seller-commercial-pricing-portal.test.js` |

A migration ML atual termina em `apps/seller-ml/db/077_bulk_sku_credits.sql`; confirmar que `078` ainda está livre antes de criar o arquivo. Em Shopee, confirmar o mecanismo de migration usado pelo módulo antes de editar schema. O mapa aponta áreas de responsabilidade, não autoriza migrações nesta fase.

## Entrega 1 — direito de teste no Hub

### Task 1: Registro único por empresa/módulo

**Files:** Hub `sql/066_seller_module_trials.sql`; `src/modules/onboarding/moduleTrial.ts`; `tests/onboarding/moduleTrial.test.ts`.

- [ ] **Step 1: Teste RED da regra pura.** Criar o teste abaixo; rodar `npm run test:checkout` (o runner atual não possui grupo `onboarding`) e observar falha por módulo ausente.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { trialWindow, trialAllowsOperation } from "../../src/modules/onboarding/moduleTrial";

test("7 dias começam na ativação e o vencimento é exclusivo", () => {
  const start = new Date("2026-10-20T12:00:00.000Z");
  const window = trialWindow(start);
  assert.equal(window.endsAt, "2026-10-27T12:00:00.000Z");
  assert.equal(trialAllowsOperation(window.endsAt, new Date("2026-10-27T11:59:59.999Z")), true);
  assert.equal(trialAllowsOperation(window.endsAt, new Date("2026-10-27T12:00:00.000Z")), false);
});
```

- [ ] **Step 2: GREEN.** Exportar `trialWindow(start: Date)` e `trialAllowsOperation(endsAt: string, now: Date)`; o primeiro soma `7 * 24 * 60 * 60 * 1000` e retorna ISO, o segundo compara `now.getTime() < Date.parse(endsAt)`.
- [ ] **Step 3: Teste RED de idempotência no serviço.** Escrever teste comportamental com repositório fake: duas chamadas `activateModuleTrial(tenantId, "ml", at)` retornam o mesmo `started_at`/`ends_at`; chamada com `"shopee"` cria outro prazo. Usar o mesmo contrato no SQL, com `PRIMARY KEY (tenant_id, module_slug)` e `INSERT ... ON CONFLICT DO NOTHING` seguido de `SELECT`; nunca atualizar `started_at` em conflito.
- [ ] **Step 4: GREEN.** Criar migration com `tenant_id` referenciando a chave real de `tenants`, `module_slug` restrito ao catálogo Seller suportado, `started_at`, `ends_at`, timestamps e chave única `(tenant_id, module_slug)`. Implementar `activateModuleTrial` com `INSERT ... ON CONFLICT DO NOTHING` e retorno do registro persistido, sem atualizar prazo existente. A criação/ativação do recurso fica na Task 3, quando a identidade da conta OAuth já é conhecida. Executar teste focado, `npm run test:migrations`, `tsc --noEmit --pretty false` e `git diff --check`.
- [ ] **Step 5: Commit isolado.** `git add sql/066_seller_module_trials.sql src/modules/onboarding/moduleTrial.ts tests/onboarding/moduleTrial.test.ts` e commit apenas esses arquivos após conferir `git diff --cached --stat`.

### Task 2: Hub distingue teste ilimitado de plano ilimitado

**Files:** Hub `src/modules/billing/resources/accessPolicy.ts`, `src/modules/billing/credits/service.ts`, `src/modules/billing/internalRoutes.ts`; testes `tests/billing/credits/creditServiceUnits.test.ts` e teste de acesso de recurso existente.

- [ ] **Step 1: Testes RED.** Recurso `temporary + unlimited` com `access_ends_at` futuro permite quote de `0 c`, não reserva saldo e mantém `purchased_balance`; no instante exato de vencimento, quote e reserve rejeitam. Recurso `unlimited + unlimited` legado permanece ilimitado. Recurso `paid + prepaid_credits` continua com cobrança normal.
- [ ] **Step 2: Executar os testes focados e confirmar que ao menos o caso de teste `temporary + unlimited`/vencimento falha pelo motivo esperado.** Não aceitar um teste que passa por tratar qualquer `unlimited` como teste.
- [ ] **Step 3: GREEN.** Fazer a avaliação de crédito depender do acesso do recurso e do registro de teste, não só do campo `consumption_model`. Retornar estado explícito `trial_unlimited` no quote de teste; preservar os contratos de quote/reserva de contas pagas. Não criar ledger debit para trial; manter telemetria de job no Seller. Aplicar a mesma verificação na reserva para impedir corrida entre modal e início do job.
- [ ] **Step 4: Verificar.** `npm run test:billing`, `npm run test:checkout`, `tsc --noEmit --pretty false`, `git diff --check`.
- [ ] **Step 5: Commit isolado** dos arquivos de billing/teste após inspeção do diff staged.

### Task 3: Endpoints internos de ativação e estado

**Files:** Hub `src/modules/portal/internalRoutes.ts`, `src/modules/portal/service.ts`, testes de portal existentes mais `tests/portal/moduleTrialRoutes.test.ts`.

- [ ] **Step 1: Testes RED.** Contrato `POST /v1/internal/portal/module-trials/activate` exige autenticação interna, `tenant_id`, `module_slug` e idempotency key de ativação. `GET`/overview retorna início, fim, estado (`available`, `active`, `expired`, `not_eligible`) e nunca retorna token OAuth. Dupla ativação preserva a data original. Empresa inexistente ou módulo inválido retorna 4xx.
- [ ] **Step 2: GREEN.** Ligar as rotas ao serviço de Task 1; associar os resource keys de contas OAuth confirmadas ao mesmo direito de teste e definir `access_policy=temporary`, `access_ends_at=ends_at`, `consumption_model=unlimited`, `metadata_json.access_reason=seller_module_trial`, sem tocar `purchased_balance` nem substituir recurso pago/legado ativo. A operação deve ser idempotente e falhar fechada se parte do provisionamento não confirmar; registrar estado pendente recuperável no Seller. Adicionar estado do teste em `resolveOverview` por módulo, com consultas em lote por tenant. Não expor endpoint público de ativação direta; o Seller chama apenas após confirmação de e-mail.
- [ ] **Step 3: Verificar.** `npm run test:checkout`, `npm run verify`, `git diff --check`; commit isolado.

## Entrega 2 — OAuth público, ativação e apuração

### Task 4: OAuth provisório e ativação por e-mail

**Files:** Dach `apps/seller-ml/routes/meliOAuthRoutes.js`, `apps/seller-ml/routes/authRoutes.js`, dois serviços em `apps/seller-ml/services/publicOnboarding*.js`, `apps/seller-ml/db/078_public_seller_onboarding.sql`, `apps/gateway/views/seller/landing-mercado-livre.html`; equivalentes Shopee e `apps/gateway/views/seller/landing-shopee.html`. Testes novos `apps/seller-ml/tests/public-onboarding-oauth.test.js` e `apps/seller-shopee/test/public-onboarding-oauth.test.js`.

- [ ] **Step 1: Testes RED.** Visitante sem login inicia OAuth com `state`/PKCE de uso único; callback só cria vínculo provisório criptografado, nunca recurso ativo. E-mail não confirmado não chama Hub. Ativação do convite associa a conta correta e chama Task 3 uma vez. Replay do callback, segundo convite ou segunda conta do mesmo módulo não altera `started_at`. A mesma conta de marketplace não pode ser reivindicada por duas empresas via sessões provisórias concorrentes.
- [ ] **Step 2: GREEN em ML.** Criar registro provisório com expiração curta e `session_id` opaco; gravar token criptografado com o utilitário existente, sem retornar token ao navegador. Na ativação de `/api/auth/activate`, criar/associar empresa e conta em transação, consumir o registro provisório e chamar Hub com chave idempotente persistida. Falha do Hub deixa estado pendente recuperável, sem acesso operacional liberado localmente. Não afrouxar a rota OAuth autenticada atual para resolver onboarding público. A CTA da landing aponta para este início público; a sessão provisória leva ao formulário de e-mail após o callback.
- [ ] **Step 3: GREEN em Shopee.** Aplicar o mesmo contrato de sessão provisória e ativação à autorização Shopee, mantendo assinatura/estado exigidos por sua API. A empresa que já testou ML pode iniciar Shopee, mas uma segunda loja Shopee não ganha novo prazo.
- [ ] **Step 4: Verificar.** Testes focados, `node --check` dos arquivos JS tocados, suites de autenticação e OAuth de ambos os módulos, `git diff --check`; commits separados por marketplace.

### Task 5: Apuração automática por conta

**Files:** Dach `apps/seller-ml/routes/accountRoutes.js`, novo `apps/seller-ml/services/closedMonthOrderMeasurement.js`; serviço de agregação Shopee já usado por `apps/seller-shopee/src/controllers/DashboardController.js`; testes de apuração.

- [ ] **Step 1: Testes RED.** Mês fechado usa início inclusivo/fim exclusivo UTC; 0 pedidos gera faixa `up_to_30`; erro de API deixa `measurement_status=failed` e nenhum range; 3.001 pedidos indica contato comercial; reconexão atualiza medição, não o relógio de teste. ML e Shopee enviam ao Hub apenas valor apurado e período, com autorização interna.
- [ ] **Step 2: GREEN.** Extrair o cálculo hoje embutido em `accountRoutes.js` para serviço reutilizável por onboarding e pré-checkout. Em Shopee, usar agregação de pedidos pagos da loja para o mês fechado, depois de sincronização completa; sem dados completos, manter `pending` e reprocessar em background. Persistir fonte, período, `measured_at`, quantidade e status por recurso.
- [ ] **Step 3: Verificar** testes focados, teste de bordas de faixa do Hub, `git diff --check`; commit isolado.

## Entrega 3 — Seleção de plataforma e cobrança

### Task 6: Painel de teste, conta e faixa atribuída

**Files:** Dach `apps/seller-ml/views/selecao-plataforma.html`, `tests/seller-portal-home.test.js`, `apps/seller-ml/tests/seller-commercial-pricing-portal.test.js`.

- [ ] **Step 1: Testes RED.** Home mostra `Disponível para testar`, dias restantes ou `Teste encerrado` por módulo; Contas mostra pedidos e faixa por conta; drawer mostra mês/fonte/erro de apuração; teste não aparece como saldo de 100 c. Módulo Shopee ainda disponível para teste após ML; segunda conta ML não cria segundo cartão de trial.
- [ ] **Step 2: GREEN.** Renderizar exclusivamente os estados recebidos do Hub. Remover campos editáveis `purchase-range` e `purchase-orders`; substituir `purchase-plan` por resumo somente leitura de faixa/valor apurados. Botão de contratar só habilita com apuração válida e <=3.000. Preservar abas, filtros, conta drawer e acesso de regularização após vencimento.
- [ ] **Step 3: Verificar** testes focados, `node --check` se script externo for extraído, testes de portal/home, inspeção visual em desktop e mobile; commit isolado.

### Task 7: Contratação, pagamento e renovação começam no painel

**Files:** Dach `apps/seller-ml/views/selecao-plataforma.html`, gateway do portal existente; Hub `src/modules/portal/internalRoutes.ts`, `src/modules/checkout/commercialService.ts`, testes de checkout/portal.

- [ ] **Step 1: Testes RED.** Navegação por Home, Contas ou Planos converge para o mesmo drawer. Payload do navegador não pode escolher faixa/preço/quantidade; Hub reapura a faixa, cria quote e snapshot. Checkout pendente preserva preço. Retorno do Asaas sem webhook não ativa acesso. Renovação individual/conjunta partem do painel e só estendem vigência após pagamento confirmado. Mais de 3.000 pedidos encaminha a contato, sem checkout automático.
- [ ] **Step 2: GREEN.** Remover autoridade de faixa/volume no `POST /api/portal/checkout` e no Hub. O Hub resolve conta, medição e matriz publicada; o Seller envia somente resource keys, finalidade, forma de pagamento e dados de cobrança. O painel abre checkout e, ao retornar, consulta status do Hub (`pending`, `paid`, `failed`), sem confiar em query string de sucesso. Renovação usa a mesma resolução de faixa/price snapshot.
- [ ] **Step 3: Verificar** testes focados, `npm run verify` do Hub, `npm run test:architecture` e testes de portal do Dach, comparação manual Hub quote/Asaas/Hub provisionado; commits isolados por repositório.

## Gates finais

- [ ] Auditoria do diff contra a especificação: OAuth antes do e-mail; sete dias uma vez por empresa/módulo; operações ilimitadas sem débito; ML e Shopee independentes; medição por conta; checkout/renovação iniciados na Seleção de plataforma; nenhuma seleção manual de faixa; nenhuma cobrança automática no fim do teste.
- [ ] Reexecutar suites completas relevantes dos dois repositórios; registrar contagem e falhas preexistentes sem afirmar que tudo passou se não passou.
- [ ] Verificar `git status --short` e `git diff --check` em ambos os checkouts; preservar arquivos preexistentes. Não executar migration ou deploy sem gate específico e aprovação operacional.
- [ ] Em rollout posterior, aplicar Hub antes do Seller, testar empresa nova controlada, observar `healthz`, OAuth, ativação, relógio, job antes/depois do vencimento, saldo e status de checkout/Asaas. Não usar cliente real como primeiro teste.

## Revisão do plano

Este plano depende da especificação já aprovada e não inclui reprecificação de operações ML. Essa discussão permanece separada; o teste ilimitado pode ser validado sem aguardar nova tarifa. Não há trabalho para outros agentes: executar inline neste chat, em pequenos lotes com teste RED/GREEN e revisão após cada entrega.
