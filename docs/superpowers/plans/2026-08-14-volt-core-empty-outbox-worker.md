# Volt Core Empty Outbox Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que uma fila outbox vazia seja interpretada como eventos concluídos, eliminando o spam de 20 logs falsos a cada ciclo do worker sem desativar a infraestrutura de integrações.

**Architecture:** O armazenamento passa a expor um contrato estrito `OutboxEvent | null`, seguindo o padrão já usado por `jobStore`. O engine deixa de aceitar `QueryResult` do PostgreSQL e encerra o lote imediatamente quando recebe `null`. Uma suíte comportamental cobre fila vazia, evento real, retry e dead-letter; o validador de staging verifica um ID inexistente sem drenar a fila compartilhada.

**Tech Stack:** Node.js 20+, CommonJS, `node:test`, PostgreSQL/`pg`, worker interno da Fase D, logs JSON estruturados.

---

## Diagnóstico confirmado

- `src/modules/integrations/outboxStore.js:44` devolve o `QueryResult` bruto de `db.query()`.
- Com a fila vazia, o PostgreSQL devolve `{ rows: [], rowCount: 0 }`.
- `src/modules/integrations/outboxEngine.js:11` usa `result?.rows?.[0] || result`; como o `QueryResult` é truthy, ele vira um evento falso.
- Esse objeto não possui `id`, `company_id` nem `event_type`. Mesmo assim, o engine encontra zero subscribers, tenta finalizar zero linhas, incrementa a métrica e grava `integration.outbox.completed`.
- `runOutboxBatch()` repete isso até 20 vezes. `worker.js` inicia outro ciclo a cada 3 segundos, o que corresponde exatamente ao padrão dos logs do Render.
- O banco consultado durante o diagnóstico não tinha backlog: havia zero eventos `pending`, `retrying` ou `processing`. Portanto, não se trata de eventos reais acumulados.

## Decisão de design

Contrato obrigatório:

```text
claimNextOutbox(workerId) -> OutboxEvent | null
claimOutboxById(workerId, eventId) -> OutboxEvent | null
processClaimedOutbox(event, workerId) recebe OutboxEvent | null
```

Não serão usados como solução:

- aumentar `VOLT_CORE_JOB_POLL_MS`;
- diminuir `VOLT_CORE_OUTBOX_BATCH_SIZE`;
- reduzir o nível do log;
- definir `VOLT_CORE_WORKER_DISABLED=true` permanentemente.

Essas opções apenas reduzem a visibilidade do erro e também interrompem o processamento legítimo de integrações.

## Estrutura de arquivos

- Criar `business/volt_core/src/modules/integrations/outboxProcessing.test.js`: testes comportamentais isolados do worker/outbox.
- Modificar `business/volt_core/src/modules/integrations/outboxStore.js`: normalizar o resultado do claim para `evento | null`.
- Modificar `business/volt_core/src/modules/integrations/outboxEngine.js`: consumir somente `evento | null`.
- Modificar `business/volt_core/package.json`: incluir a nova suíte no comando oficial `npm test`.
- Modificar `business/volt_core/scripts/validate-phase-d.js`: comprovar no staging que um ID inexistente é um no-op seguro.
- Preservar `business/volt_core/src/modules/integrations/worker.js`: intervalo e tamanho do lote estão corretos e não causam o defeito.
- Nenhuma migration será criada ou executada por esta correção.

### Task 1: Preparar a branch correta sem transportar mudanças da `dev`

**Files:**
- Inspect: repository worktree
- Target branch: `voltdev`

- [ ] **Step 1: Confirmar o estado antes da troca**

Run:

```powershell
git status -sb
git branch --show-current
```

Expected: a branch atual é `dev`; não pode existir alteração de código não relacionada. O documento deste plano pode aparecer como novo arquivo.

- [ ] **Step 2: Trocar para a branch de staging e atualizá-la**

Run:

```powershell
git checkout voltdev
git pull --rebase origin voltdev
git status -sb
```

Expected: `## voltdev...origin/voltdev`, sem divergência. O histórico deve conter o commit `1c68f42d`, que corrige o loop de buscas do PDV óptico.

- [ ] **Step 3: Confirmar que o bug ainda existe na base atualizada**

Run:

```powershell
rg -n "return db.withRlsBypass|result\?\.rows\?\.\[0\] \|\| result" business/volt_core/src/modules/integrations/outboxStore.js business/volt_core/src/modules/integrations/outboxEngine.js
```

Expected: o store ainda devolve `db.query()` diretamente e o engine ainda contém o fallback ambíguo.

### Task 2: Criar regressão RED para fila vazia

**Files:**
- Create: `business/volt_core/src/modules/integrations/outboxProcessing.test.js`
- Modify: `business/volt_core/package.json`

- [ ] **Step 1: Criar a infraestrutura de mocks restauráveis**

Criar o arquivo com imports e helper abaixo. O helper substitui somente métodos do objeto já carregado e restaura todos no `finally`.

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../../db/db");
const logger = require("../../observability/logger");
const metrics = require("../../observability/metrics");
const { claimNextOutbox, claimOutboxById } = require("./outboxStore");
const { runOutboxBatch } = require("./outboxEngine");
const { registerOutboxHandler } = require("./registry");

async function withOutboxRuntime(query, run) {
  const original = {
    query: db.query,
    withRlsBypass: db.withRlsBypass,
    withTenantContext: db.withTenantContext,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    recordIntegration: metrics.recordIntegration,
  };
  const observed = { logs: [], metrics: [], tenants: [] };
  db.query = (text, params) => query(String(text), params || []);
  db.withRlsBypass = (callback) => callback();
  db.withTenantContext = (companyId, callback) => {
    observed.tenants.push(companyId);
    return callback();
  };
  logger.info = (event, fields) => observed.logs.push({ level: "info", event, fields });
  logger.warn = (event, fields) => observed.logs.push({ level: "warn", event, fields });
  logger.error = (event, fields) => observed.logs.push({ level: "error", event, fields });
  metrics.recordIntegration = (name) => observed.metrics.push(name);
  try {
    return await run(observed);
  } finally {
    db.query = original.query;
    db.withRlsBypass = original.withRlsBypass;
    db.withTenantContext = original.withTenantContext;
    logger.info = original.info;
    logger.warn = original.warn;
    logger.error = original.error;
    metrics.recordIntegration = original.recordIntegration;
  }
}
```

- [ ] **Step 2: Escrever os dois testes que reproduzem o defeito**

Adicionar ao mesmo arquivo:

```js
test("empty outbox claim returns null instead of PostgreSQL QueryResult", async () => {
  let queryCount = 0;
  await withOutboxRuntime(async () => {
    queryCount += 1;
    return { rows: [], rowCount: 0 };
  }, async () => {
    assert.equal(await claimNextOutbox("worker-empty-store"), null);
    assert.equal(await claimOutboxById("worker-empty-store", "outbox-missing"), null);
    assert.equal(queryCount, 2);
  });
});

test("empty outbox batch stops after one claim without log or metric", async () => {
  let queryCount = 0;
  await withOutboxRuntime(async () => {
    queryCount += 1;
    return { rows: [], rowCount: 0 };
  }, async (observed) => {
    const processed = await runOutboxBatch("worker-empty-batch", 20);
    assert.deepEqual(processed, []);
    assert.equal(queryCount, 1);
    assert.deepEqual(observed.logs, []);
    assert.deepEqual(observed.metrics, []);
    assert.deepEqual(observed.tenants, []);
  });
});
```

- [ ] **Step 3: Registrar a suíte no comando oficial**

No `business/volt_core/package.json`, substituir o valor atual de `scripts.test` por esta linha completa:

```json
"test": "node --test src/modules/auth/authService.test.js src/modules/core/core.test.js src/modules/core/coreOperations.test.js src/modules/core/platformFoundation.test.js src/modules/core/platformEnginePhase2.test.js src/modules/core/commercialPhaseE.test.js src/modules/core/extensionArchitecture.test.js src/modules/core/runtimeHttp.test.js src/modules/core/preflight.test.js src/modules/core/preGoLiveRegression.test.js src/modules/core/workspaceV2.test.js src/modules/integrations/outboxProcessing.test.js src/modules/integrations/phaseD.test.js"
```

Isso inclui a nova suíte imediatamente antes de `phaseD.test.js` e preserva todos os testes já existentes.

- [ ] **Step 4: Executar o teste e registrar o RED real**

Run from `business/volt_core`:

```powershell
node --test src/modules/integrations/outboxProcessing.test.js
```

Expected before implementation: FAIL. O primeiro teste recebe um objeto no lugar de `null`; o segundo demonstra múltiplas queries/processamentos em vez de parar após um claim vazio. Não alterar o teste para acomodar o comportamento atual.

### Task 3: Implementar o contrato mínimo `evento | null`

**Files:**
- Modify: `business/volt_core/src/modules/integrations/outboxStore.js:44-58`
- Modify: `business/volt_core/src/modules/integrations/outboxEngine.js:11-13`
- Test: `business/volt_core/src/modules/integrations/outboxProcessing.test.js`

- [ ] **Step 1: Normalizar o resultado em `claimOutbox()`**

Substituir a função por:

```js
async function claimOutbox(workerId, eventId = null) {
  const result = await db.withRlsBypass(() => db.query(`
    with candidate as (
      select id from volt_core.integration_outbox_events
       where status in ('pending','retrying') and available_at <= now()
         and ($2::text is null or id=$2)
       order by available_at asc, created_at asc
       for update skip locked limit 1
    )
    update volt_core.integration_outbox_events e
       set status='processing', attempts=e.attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
      from candidate where e.id=candidate.id
    returning e.*;
  `, [workerId, eventId]));
  return result.rows[0] || null;
}
```

- [ ] **Step 2: Remover o fallback ambíguo do engine**

Alterar o início da função para:

```js
async function processClaimedOutbox(event, workerId) {
  if (!event) return null;
```

Todo o restante do processamento permanece igual. Não adicionar detecção por propriedades ou compatibilidade com `QueryResult`: a fronteira do store deve ser a única responsável pela normalização.

- [ ] **Step 3: Executar novamente a regressão**

Run:

```powershell
node --test src/modules/integrations/outboxProcessing.test.js
```

Expected: 2 testes passando; fila vazia produz exatamente um claim, nenhum processamento, nenhuma métrica e nenhum log.

### Task 4: Cobrir um evento real e os caminhos de falha

**Files:**
- Modify: `business/volt_core/src/modules/integrations/outboxProcessing.test.js`

- [ ] **Step 1: Adicionar factory de evento**

```js
function outboxEvent(overrides = {}) {
  return {
    id: "outbox-test-1",
    company_id: "company-test-1",
    event_type: "test.outbox.completed",
    payload: { probe: true },
    request_id: "request-test-1",
    correlation_id: "correlation-test-1",
    attempts: 1,
    max_attempts: 3,
    ...overrides,
  };
}
```

- [ ] **Step 2: Garantir processamento único de evento real**

Adicionar o teste:

```js
test("one real outbox event is dispatched and completed exactly once", async () => {
  const event = outboxEvent();
  let claims = 0;
  let finishes = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async ({ payload }) => ({ consumed: payload.probe }));
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        finishes += 1;
        assert.equal(params[2], "completed");
        assert.deepEqual(JSON.parse(params[3]), { dispatched: 1, outputs: [{ consumed: true }] });
        return { rows: [{ ...event, status: "completed" }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-real-event", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(finishes, 1);
      assert.deepEqual(observed.tenants, [event.company_id]);
      assert.deepEqual(observed.metrics, ["completedOutbox"]);
      const completed = observed.logs.filter((entry) => entry.event === "integration.outbox.completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0].fields.companyId, event.company_id);
      assert.equal(completed[0].fields.outboxId, event.id);
      assert.equal(completed[0].fields.eventType, event.event_type);
    });
  } finally {
    removeHandler();
  }
});
```

- [ ] **Step 3: Garantir retry único para falha transitória**

Adicionar o teste:

```js
test("transient outbox failure is scheduled once for retry", async () => {
  const event = outboxEvent({ event_type: "test.outbox.retry" });
  let claims = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async () => {
    const error = new Error("temporary provider failure");
    error.code = "TEST_PROVIDER_TEMPORARY";
    error.retryable = true;
    throw error;
  });
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        assert.equal(params[2], "retrying");
        assert.equal(params[4], "TEST_PROVIDER_TEMPORARY");
        assert.ok(new Date(params[6]).getTime() > Date.now());
        return { rows: [{ ...event, status: "retrying" }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-retry", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.retry").length, 1);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.completed").length, 0);
      assert.equal(observed.metrics.includes("completedOutbox"), false);
    });
  } finally {
    removeHandler();
  }
});
```

- [ ] **Step 4: Garantir dead-letter no limite de tentativas**

Adicionar o teste:

```js
test("outbox failure at attempt limit is moved to dead letter once", async () => {
  const event = outboxEvent({ event_type: "test.outbox.dead", attempts: 3, max_attempts: 3 });
  let claims = 0;
  const removeHandler = registerOutboxHandler(event.event_type, async () => {
    const error = new Error("permanent failure");
    error.code = "TEST_PROVIDER_PERMANENT";
    throw error;
  });
  try {
    await withOutboxRuntime(async (text, params) => {
      if (/with candidate/i.test(text)) {
        claims += 1;
        return claims === 1 ? { rows: [event], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/set status=\$3/i.test(text)) {
        assert.equal(params[2], "dead_letter");
        assert.equal(params[6], null);
        return { rows: [{ ...event, status: "dead_letter" }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no teste: ${text}`);
    }, async (observed) => {
      const processed = await runOutboxBatch("worker-dead-letter", 20);
      assert.equal(processed.length, 1);
      assert.equal(claims, 2);
      assert.equal(observed.logs.filter((entry) => entry.event === "integration.outbox.dead_letter").length, 1);
      assert.deepEqual(observed.metrics, ["deadLetterOutbox"]);
    });
  } finally {
    removeHandler();
  }
});
```

- [ ] **Step 5: Executar a suíte comportamental completa**

Run:

```powershell
node --test src/modules/integrations/outboxProcessing.test.js
```

Expected: 5 testes passando, zero falhas.

- [ ] **Step 6: Criar o commit atômico da correção**

Run from repository root:

```powershell
git add business/volt_core/src/modules/integrations/outboxStore.js business/volt_core/src/modules/integrations/outboxEngine.js business/volt_core/src/modules/integrations/outboxProcessing.test.js business/volt_core/package.json docs/superpowers/plans/2026-08-14-volt-core-empty-outbox-worker.md
git commit -m "fix(volt-core): stop processing empty outbox claims"
```

Expected: um commit contendo somente o contrato, o engine, a regressão e este plano.

### Task 5: Ampliar a validação segura da Fase D

**Files:**
- Modify: `business/volt_core/scripts/validate-phase-d.js:97-106,133`

- [ ] **Step 1: Verificar explicitamente um ID inexistente**

Logo após validar o evento real, adicionar:

```js
      const missingOutbox = await processOutboxById(workerId, `outbox-missing-${suffix}`);
      assert.equal(missingOutbox, null);
```

Esse caminho usa um ID exclusivo e não pode reivindicar eventos reais de outros fluxos. Não usar `runOutboxBatch()` no validador de staging.

- [ ] **Step 2: Expor o check no resultado do validador**

Alterar a lista final para:

```js
checks: [
  "job_completed",
  "dead_letter",
  "manual_retry",
  "outbox_dispatch",
  "empty_outbox_noop",
  "webhook_deduplication",
  "webhook_header_sanitization",
],
```

- [ ] **Step 3: Executar validação de sintaxe e teste estático existente**

Run from `business/volt_core`:

```powershell
node --check scripts/validate-phase-d.js
node --test src/modules/integrations/phaseD.test.js
```

Expected: sintaxe válida e todos os testes de `phaseD.test.js` passando. O teste existente deve continuar confirmando que o validador não contém `runOutboxBatch`.

- [ ] **Step 4: Criar o commit da validação**

Run from repository root:

```powershell
git add business/volt_core/scripts/validate-phase-d.js
git commit -m "test(volt-core): validate empty outbox no-op"
```

### Task 6: Executar a porta completa de verificação local

**Files:**
- Verify only

- [ ] **Step 1: Rodar a suíte oficial**

Run from `business/volt_core`:

```powershell
npm test
```

Expected: todos os testes antigos mais os 5 novos passam; zero falhas, cancelamentos ou testes ignorados inesperadamente.

- [ ] **Step 2: Rodar preflight e build**

Run:

```powershell
npm run preflight
npm run build
```

Expected: preflight concluído e build Vite finalizado sem erro. Warnings antigos devem ser registrados separadamente e não confundidos com falha desta correção.

- [ ] **Step 3: Verificar whitespace e escopo do diff**

Run from repository root:

```powershell
git diff --check HEAD~2..HEAD
git show --stat --oneline HEAD~2..HEAD
git status -sb
```

Expected: `git diff --check` sem saída; apenas os cinco arquivos previstos mais este plano aparecem nos dois commits; branch `voltdev` limpa e à frente do remoto.

### Task 7: Push, deploy e validação no staging

**Files:**
- Remote branch: `origin/voltdev`
- Staging: `https://volt-staging.onrender.com`

- [ ] **Step 1: Enviar somente após todas as verificações locais passarem**

Run from repository root:

```powershell
git push origin voltdev
```

Expected: push aceito sem force e Render inicia um deploy da `voltdev`.

- [ ] **Step 2: Confirmar saúde após o deploy**

Run:

```powershell
curl.exe -fsS https://volt-staging.onrender.com/health
curl.exe -fsS https://volt-staging.onrender.com/api/core/health
```

Expected: HTTP 200; serviço e banco saudáveis; worker iniciado e `lastError` ausente/nulo.

- [ ] **Step 3: Executar o validador contra staging**

Run from `business/volt_core`, com as URLs de staging já configuradas no ambiente local:

```powershell
npm run validate:phase-d
```

Expected JSON:

```json
{
  "ok": true,
  "checks": [
    "job_completed",
    "dead_letter",
    "manual_retry",
    "outbox_dispatch",
    "empty_outbox_noop",
    "webhook_deduplication",
    "webhook_header_sanitization"
  ]
}
```

- [ ] **Step 4: Validar ausência de spam em repouso**

Observar os logs por pelo menos 10 segundos, cobrindo mais de três ciclos de 3 segundos.

Expected:

- nenhuma sequência de `integration.outbox.completed` enquanto não há novos eventos;
- nenhum log de conclusão sem `companyId`, `outboxId` e `eventType`;
- nenhum `integration.worker.error`;
- nenhum `integration.outbox.dead_letter` inesperado.

- [ ] **Step 5: Validar um evento real**

Executar uma operação de baixo risco que gere evento, preferencialmente o probe de `validate:phase-d`; não emitir documento fiscal real.

Expected:

- exatamente uma conclusão por evento criado;
- o log contém `companyId`, `outboxId`, `eventType` e o número real de subscribers;
- o registro correspondente fica `completed`;
- não há duplicação em ciclos seguintes.

## Rollback e mitigação emergencial

Se o deploy falhar por causa desta mudança:

1. reverter os dois commits com `git revert`, preservando histórico;
2. fazer push normal para `voltdev`;
3. somente durante a investigação, `VOLT_CORE_WORKER_DISABLED=true` pode ser usado como mitigação emergencial para estabilizar o runtime;
4. remover a variável assim que a correção for restabelecida, pois com ela ativa jobs, webhooks e outbox legítimos deixam de ser processados.

Não há rollback de banco porque esta correção não inclui migration nem alteração de dados.

## Critérios de aceite

- Fila vazia resulta em `null` e encerra o lote após um único claim.
- Fila vazia não gera log, métrica, tenant context nem chamada de finalização.
- Um evento real é processado e finalizado exatamente uma vez.
- Retry e dead-letter continuam funcionando sem regressão.
- `npm test`, `npm run preflight`, `npm run build` e `git diff --check` passam.
- `validate:phase-d` retorna `ok: true` incluindo `empty_outbox_noop`.
- Staging permanece sem spam por mais de três ciclos ociosos.
- Logs reais sempre possuem `companyId`, `outboxId` e `eventType`.

## Fora do escopo deste hotfix

- Normalizar `finishOutbox()` para `OutboxEvent | null` e transformar update de zero linhas em erro de invariância. É um hardening útil, mas deve ser uma mudança separada para não ampliar o hotfix.
- Criar métrica `retriedOutbox`; o modelo atual possui `completedOutbox` e `deadLetterOutbox`, mas não possui esse contador.
- Alterar frequência do worker ou dimensionamento de lote.
- Alterar schema, RLS ou migrations.
