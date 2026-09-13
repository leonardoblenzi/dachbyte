# Volt Core Shared Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduzir a carga ociosa do worker do Volt Core no webservice compartilhado sem perder processamento durável, mantendo logs úteis e um único processo Uvicorn.

**Architecture:** O worker usará um `setTimeout` autoagendado com backoff ocioso, jitter e `wake()` por sinal independente. Configuração numérica será validada antes do startup. Access logs HTTP terão modo próprio, separado do nível global, e o Volt Chat fixará um worker Uvicorn.

**Tech Stack:** Node.js 20, CommonJS, `node:test`, Express, PostgreSQL, Uvicorn.

---

## Estrutura de arquivos

- Criar `business/volt_core/src/modules/integrations/workerConfig.js`: parsing e limites das variáveis do worker.
- Criar `business/volt_core/src/modules/integrations/workerSignal.js`: sinal em memória para acordar o singleton sem dependência circular.
- Criar `business/volt_core/src/modules/integrations/worker.test.js`: testes determinísticos do scheduler e da configuração.
- Modificar `business/volt_core/src/modules/integrations/worker.js`: scheduler adaptativo, status e `wake()`.
- Modificar `business/volt_core/src/modules/integrations/jobStore.js`: acordar depois do commit controlado pelo store.
- Modificar `business/volt_core/src/modules/integrations/outboxStore.js`: acordar depois do commit controlado pelo store.
- Criar `business/volt_core/src/middlewares/requestObservability.test.js`: contrato de access logs.
- Modificar `business/volt_core/src/middlewares/requestObservability.js`: modo `all|slow-errors|errors|off`.
- Modificar `business/volt_core/src/modules/integrations/outboxProcessing.test.js`: nível de log para eventos sem subscribers.
- Modificar `business/volt_core/src/modules/integrations/outboxEngine.js`: usar `debug` quando não houve dispatch.
- Criar `business/lib/startRuntime.test.js`: contrato do subprocesso Uvicorn.
- Modificar `business/start.js`: adicionar `--workers 1`.
- Modificar `business/package.json` e `business/volt_core/package.json`: incluir as novas suítes.

### Task 1: Validar configuração do worker

**Files:**
- Create: `business/volt_core/src/modules/integrations/workerConfig.js`
- Create: `business/volt_core/src/modules/integrations/worker.test.js`
- Modify: `business/volt_core/package.json`

- [ ] **Step 1: Escrever os testes RED da configuração**

Adicionar a `worker.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWorkerConfig } = require("./workerConfig");

test("worker config preserves defaults and legacy active poll variable", () => {
  const defaults = resolveWorkerConfig({});
  assert.equal(defaults.pollMs, 3000);
  assert.equal(defaults.idleMaxMs, 60000);
  assert.equal(defaults.idleBackoffFactor, 2);
  assert.equal(defaults.jitterRatio, 0.15);

  const legacy = resolveWorkerConfig({ VOLT_CORE_JOB_POLL_MS: "15000" });
  assert.equal(legacy.pollMs, 15000);
});

test("worker config rejects non finite and out of range values", () => {
  for (const environment of [
    { VOLT_CORE_JOB_POLL_MS: "nope" },
    { VOLT_CORE_JOB_BATCH_SIZE: "0" },
    { VOLT_CORE_WORKER_IDLE_MAX_MS: "2000", VOLT_CORE_JOB_POLL_MS: "3000" },
    { VOLT_CORE_WORKER_JITTER_RATIO: "0.8" },
  ]) {
    assert.throws(() => resolveWorkerConfig(environment), (error) => {
      assert.equal(error.code, "WORKER_CONFIG_INVALID");
      return true;
    });
  }
});
```

- [ ] **Step 2: Registrar e executar a suíte para confirmar RED**

Adicionar `src/modules/integrations/worker.test.js` ao script `test` do `business/volt_core/package.json`.

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: FAIL com `Cannot find module './workerConfig'`.

- [ ] **Step 3: Implementar o parser mínimo**

Criar `workerConfig.js`:

```js
"use strict";

function invalid(name, value, minimum, maximum) {
  const error = new Error(`${name} deve ser um numero entre ${minimum} e ${maximum}; recebido: ${value}.`);
  error.code = "WORKER_CONFIG_INVALID";
  return error;
}

function numberSetting(environment, name, fallback, minimum, maximum, options = {}) {
  const raw = environment[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (options.integer && !Number.isInteger(parsed))) {
    throw invalid(name, raw, minimum, maximum);
  }
  return parsed;
}

function resolveWorkerConfig(environment = process.env, overrides = {}) {
  const merged = {
    ...environment,
    ...(overrides.pollMs == null ? {} : { VOLT_CORE_JOB_POLL_MS: overrides.pollMs }),
    ...(overrides.idleMaxMs == null ? {} : { VOLT_CORE_WORKER_IDLE_MAX_MS: overrides.idleMaxMs }),
    ...(overrides.idleBackoffFactor == null ? {} : { VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR: overrides.idleBackoffFactor }),
    ...(overrides.jitterRatio == null ? {} : { VOLT_CORE_WORKER_JITTER_RATIO: overrides.jitterRatio }),
    ...(overrides.batchSize == null ? {} : { VOLT_CORE_JOB_BATCH_SIZE: overrides.batchSize }),
    ...(overrides.outboxBatchSize == null ? {} : { VOLT_CORE_OUTBOX_BATCH_SIZE: overrides.outboxBatchSize }),
    ...(overrides.leaseMs == null ? {} : { VOLT_CORE_JOB_LEASE_MS: overrides.leaseMs }),
    ...(overrides.recoveryEveryMs == null ? {} : { VOLT_CORE_JOB_RECOVERY_MS: overrides.recoveryEveryMs }),
    ...(overrides.maintenanceEveryMs == null ? {} : { VOLT_CORE_INTEGRATION_MAINTENANCE_MS: overrides.maintenanceEveryMs }),
  };
  const pollMs = numberSetting(merged, "VOLT_CORE_JOB_POLL_MS", 3000, 500, 300000, { integer: true });
  const idleMaxMs = numberSetting(merged, "VOLT_CORE_WORKER_IDLE_MAX_MS", 60000, pollMs, 900000, { integer: true });
  return {
    pollMs,
    idleMaxMs,
    idleBackoffFactor: numberSetting(merged, "VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR", 2, 1, 10),
    jitterRatio: numberSetting(merged, "VOLT_CORE_WORKER_JITTER_RATIO", 0.15, 0, 0.5),
    batchSize: numberSetting(merged, "VOLT_CORE_JOB_BATCH_SIZE", 10, 1, 1000, { integer: true }),
    outboxBatchSize: numberSetting(merged, "VOLT_CORE_OUTBOX_BATCH_SIZE", 20, 1, 1000, { integer: true }),
    leaseMs: numberSetting(merged, "VOLT_CORE_JOB_LEASE_MS", 300000, 30000, 86400000, { integer: true }),
    recoveryEveryMs: numberSetting(merged, "VOLT_CORE_JOB_RECOVERY_MS", 60000, 30000, 86400000, { integer: true }),
    maintenanceEveryMs: numberSetting(merged, "VOLT_CORE_INTEGRATION_MAINTENANCE_MS", 21600000, 3600000, 604800000, { integer: true }),
  };
}

module.exports = { numberSetting, resolveWorkerConfig };
```

- [ ] **Step 4: Confirmar GREEN**

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit da configuração**

```powershell
git add business\volt_core\package.json business\volt_core\src\modules\integrations\workerConfig.js business\volt_core\src\modules\integrations\worker.test.js
git commit -m "test(volt-core): validate worker configuration"
```

### Task 2: Implementar scheduler adaptativo

**Files:**
- Create: `business/volt_core/src/modules/integrations/workerSignal.js`
- Modify: `business/volt_core/src/modules/integrations/worker.test.js`
- Modify: `business/volt_core/src/modules/integrations/worker.js`

- [ ] **Step 1: Escrever testes RED com relógio e timers injetados**

Acrescentar a `worker.test.js` um fake scheduler que armazena callbacks e os testes:

```js
const { createIntegrationWorker } = require("./worker");

function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    scheduled,
    setTimeout(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { callback, delay });
      return { id, unref() {} };
    },
    clearTimeout(timer) { scheduled.delete(timer?.id); },
    async runNext() {
      const [id, item] = scheduled.entries().next().value;
      scheduled.delete(id);
      await item.callback();
      return item.delay;
    },
  };
}

test("empty cycles back off to the idle ceiling and work resets the delay", async () => {
  const timers = fakeTimers();
  let jobs = 0;
  const worker = createIntegrationWorker({
    workerId: "adaptive-test",
    pollMs: 1000,
    idleMaxMs: 4000,
    idleBackoffFactor: 2,
    jitterRatio: 0,
    timers,
    databaseEnabled: () => true,
    recoverJobs: async () => null,
    recoverOutbox: async () => null,
    maintain: async () => null,
    runJobs: async () => Array.from({ length: jobs }),
    runOutbox: async () => [],
    now: () => Date.parse("2026-08-14T12:00:00Z"),
  });

  await worker.start();
  assert.equal(worker.status().currentPollMs, 2000);
  await timers.runNext();
  assert.equal(worker.status().currentPollMs, 4000);
  await timers.runNext();
  assert.equal(worker.status().currentPollMs, 4000);

  jobs = 1;
  await timers.runNext();
  assert.equal(worker.status().currentPollMs, 1000);
  assert.equal(worker.status().idleCycles, 0);
  await worker.stop();
});

test("wake replaces the idle timer without overlapping a running cycle", async () => {
  const timers = fakeTimers();
  const worker = createIntegrationWorker({
    pollMs: 1000, idleMaxMs: 60000, jitterRatio: 0, timers,
    databaseEnabled: () => true,
    recoverJobs: async () => null, recoverOutbox: async () => null, maintain: async () => null,
    runJobs: async () => [], runOutbox: async () => [],
  });
  await worker.start();
  assert.equal(timers.scheduled.size, 1);
  worker.wake();
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 0);
  await worker.stop();
  assert.equal(timers.scheduled.size, 0);
});
```

- [ ] **Step 2: Executar e confirmar RED**

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: FAIL porque `createIntegrationWorker` ainda usa `setInterval`, não aceita dependências e não expõe `wake/currentPollMs/idleCycles`.

- [ ] **Step 3: Criar o sinal desacoplado**

Criar `workerSignal.js`:

```js
"use strict";

const listeners = new Set();

function onIntegrationQueueWake(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyIntegrationQueue() {
  for (const listener of listeners) listener();
}

module.exports = { notifyIntegrationQueue, onIntegrationQueueWake };
```

- [ ] **Step 4: Substituir o intervalo pelo scheduler autoagendado**

Em `worker.js`, resolver a configuração com `resolveWorkerConfig`, injetar funções usadas pelos testes e implementar:

```js
function jittered(base, ratio, random) {
  if (!ratio) return base;
  const multiplier = 1 + ((random() * 2) - 1) * ratio;
  return Math.max(0, Math.round(base * multiplier));
}

function schedule(delay) {
  if (!started || stopped) return;
  if (timer) timers.clearTimeout(timer);
  currentPollMs = delay;
  nextRunAt = new Date(now() + delay).toISOString();
  timer = timers.setTimeout(() => {
    timer = null;
    void runScheduledCycle();
  }, delay);
  if (unrefTimer) timer.unref?.();
}

function nextDelay(result) {
  const worked = Number(result?.jobs || 0) + Number(result?.outbox || 0) > 0;
  if (worked || result?.error) {
    idleCycles = 0;
    return pollMs;
  }
  idleCycles += 1;
  const base = Math.min(idleMaxMs, Math.max(pollMs, currentPollMs || pollMs) * idleBackoffFactor);
  return Math.min(idleMaxMs, Math.max(pollMs, jittered(base, jitterRatio, random)));
}

async function runScheduledCycle() {
  const result = await runOnce();
  if (!started || stopped) return result;
  if (wakeRequested) {
    wakeRequested = false;
    schedule(0);
  } else {
    schedule(nextDelay(result));
  }
  return result;
}

function wake() {
  if (!started || stopped) return false;
  if (running) {
    wakeRequested = true;
    return true;
  }
  schedule(0);
  return true;
}
```

`start()` deverá executar `runScheduledCycle()` imediatamente, registrar o listener global e não criar `setInterval`. `stop()` deverá remover o listener, cancelar o timeout e manter a espera pelo ciclo corrente. `status()` deverá incluir `idleMaxMs`, `currentPollMs`, `idleCycles` e `nextRunAt`.

- [ ] **Step 5: Confirmar GREEN e ausência de handles órfãos**

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: todos os testes de `worker.test.js` PASS e processo encerra sem timeout.

- [ ] **Step 6: Commit do scheduler**

```powershell
git add business\volt_core\src\modules\integrations\worker.js business\volt_core\src\modules\integrations\worker.test.js business\volt_core\src\modules\integrations\workerSignal.js
git commit -m "feat(volt-core): back off idle integration worker"
```

### Task 3: Acordar o worker depois de enqueues próprios

**Files:**
- Modify: `business/volt_core/src/modules/integrations/worker.test.js`
- Modify: `business/volt_core/src/modules/integrations/jobStore.js`
- Modify: `business/volt_core/src/modules/integrations/outboxStore.js`

- [ ] **Step 1: Escrever testes RED de notificação pós-commit**

Adicionar testes que registram um listener real com `onIntegrationQueueWake`, substituem temporariamente `db.withClient` por um cliente fake, executam `enqueueJob`/`enqueueOutboxEvent` e registram a ordem:

```js
const removeWakeListener = onIntegrationQueueWake(() => order.push("notify"));
try {
  await enqueueOutboxEvent("company-test", "test.event", { probe: true });
  assert.deepEqual(order, ["begin", "insert", "commit", "notify"]);
} finally {
  removeWakeListener();
  db.withClient = originalWithClient;
}
```

Adicionar também o caso de rollback:

```js
assert.deepEqual(order, ["begin", "insert", "rollback"]);
assert.equal(notifications, 0);
```

- [ ] **Step 2: Confirmar RED**

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: FAIL porque os stores ainda não chamam o sinal.

- [ ] **Step 3: Notificar somente após commit**

Em `jobStore.js` e `outboxStore.js`, importar:

```js
const { notifyIntegrationQueue } = require("./workerSignal");
```

Depois do `await client.query("commit")` dos métodos que controlam a transação:

```js
notifyIntegrationQueue();
return job;
```

e:

```js
notifyIntegrationQueue();
return event;
```

Não notificar nos helpers `WithClient`, porque o chamador ainda pode fazer rollback.

- [ ] **Step 4: Confirmar GREEN**

Run:

```powershell
cmd /c node --test src\modules\integrations\worker.test.js
```

Expected: notificação após commit e zero notificação após rollback.

- [ ] **Step 5: Commit do wake pós-commit**

```powershell
git add business\volt_core\src\modules\integrations\jobStore.js business\volt_core\src\modules\integrations\outboxStore.js business\volt_core\src\modules\integrations\worker.test.js
git commit -m "feat(volt-core): wake worker after durable enqueue"
```

### Task 4: Separar access logs e reduzir completion sem subscribers

**Files:**
- Create: `business/volt_core/src/middlewares/requestObservability.test.js`
- Modify: `business/volt_core/src/middlewares/requestObservability.js`
- Modify: `business/volt_core/src/modules/integrations/outboxProcessing.test.js`
- Modify: `business/volt_core/src/modules/integrations/outboxEngine.js`
- Modify: `business/volt_core/package.json`

- [ ] **Step 1: Escrever testes RED do modo HTTP**

Em `requestObservability.test.js`, testar a função exportada `resolveHttpLogAction`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveHttpLogAction } = require("./requestObservability");

test("slow-errors ignores successful fast requests and keeps slow and server errors", () => {
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 200, durationMs: 20, threshold: 1000, isApi: true }), null);
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 304, durationMs: 20, threshold: 1000, isApi: true }), null);
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 200, durationMs: 1200, threshold: 1000, isApi: true }), "warn");
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 503, durationMs: 20, threshold: 1000, isApi: true }), "error");
});

test("all preserves info access logs and off suppresses only request logs", () => {
  assert.equal(resolveHttpLogAction({ mode: "all", statusCode: 200, durationMs: 20, threshold: 1000, isApi: true }), "info");
  assert.equal(resolveHttpLogAction({ mode: "off", statusCode: 503, durationMs: 20, threshold: 1000, isApi: true }), null);
});
```

Adicionar o arquivo ao script `test` do Core.

- [ ] **Step 2: Escrever RED para outbox sem subscribers**

Atualizar o helper de `outboxProcessing.test.js` para capturar `logger.debug`. Acrescentar um teste com evento real sem handler e exigir:

```js
assert.equal(observed.logs[0].level, "debug");
assert.equal(observed.logs[0].fields.subscribers, 0);
assert.equal(observed.logs[0].fields.outboxId, event.id);
```

- [ ] **Step 3: Executar e confirmar RED**

Run:

```powershell
cmd /c node --test src\middlewares\requestObservability.test.js src\modules\integrations\outboxProcessing.test.js
```

Expected: FAIL porque `resolveHttpLogAction` não existe e outbox usa `logger.info`.

- [ ] **Step 4: Implementar a decisão de access log**

Em `requestObservability.js`:

```js
function httpLogMode(environment = process.env) {
  const fallback = String(environment.NODE_ENV || "").toLowerCase() === "production" ? "slow-errors" : "all";
  const mode = String(environment.VOLT_CORE_HTTP_LOG_MODE || fallback).trim().toLowerCase();
  return ["all", "slow-errors", "errors", "off"].includes(mode) ? mode : fallback;
}

function resolveHttpLogAction({ mode, statusCode, durationMs, threshold, isApi }) {
  if (mode === "off") return null;
  if (statusCode >= 500) return "error";
  if (mode !== "errors" && durationMs >= threshold) return "warn";
  if (mode === "all" && isApi) return "info";
  return null;
}
```

O middleware chama essa função no `finish`, mantém `metrics.recordRequest` incondicional e mapeia `error`, `warn` e `info` aos mesmos eventos atuais.

- [ ] **Step 5: Rebaixar somente completion sem dispatch**

Em `outboxEngine.js`:

```js
const logCompleted = handlers.length ? logger.info : logger.debug;
logCompleted("integration.outbox.completed", {
  requestId: event.request_id,
  correlationId: event.correlation_id,
  companyId: event.company_id,
  outboxId: event.id,
  eventType: event.event_type,
  subscribers: handlers.length,
});
```

- [ ] **Step 6: Confirmar GREEN**

Run:

```powershell
cmd /c node --test src\middlewares\requestObservability.test.js src\modules\integrations\outboxProcessing.test.js
```

Expected: todas as decisões de log PASS; eventos com subscriber continuam em `info`.

- [ ] **Step 7: Commit de observabilidade**

```powershell
git add business\volt_core\package.json business\volt_core\src\middlewares\requestObservability.js business\volt_core\src\middlewares\requestObservability.test.js business\volt_core\src\modules\integrations\outboxEngine.js business\volt_core\src\modules\integrations\outboxProcessing.test.js
git commit -m "feat(volt-core): control idle integration logs"
```

### Task 5: Fixar um processo Uvicorn

**Files:**
- Create: `business/lib/startRuntime.test.js`
- Modify: `business/start.js`
- Modify: `business/package.json`

- [ ] **Step 1: Escrever teste RED do entrypoint**

Criar `startRuntime.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("business pins Volt Chat uvicorn to one worker", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "start.js"), "utf8");
  assert.match(source, /"--workers",\s*"1"/);
});
```

Adicionar `lib/startRuntime.test.js` ao script `test` de `business/package.json`.

- [ ] **Step 2: Confirmar RED**

Run:

```powershell
cmd /c node --test lib\startRuntime.test.js
```

Expected: FAIL porque o argumento ainda não existe.

- [ ] **Step 3: Fixar `--workers 1`**

Alterar os argumentos do `spawn` em `business/start.js` para:

```js
["-m", "uvicorn", "sordchat_fixed:app", "--host", "127.0.0.1", "--port", chatApiPort, "--workers", "1"]
```

- [ ] **Step 4: Confirmar GREEN**

Run:

```powershell
cmd /c node --test lib\startRuntime.test.js
```

Expected: 1/1 PASS.

- [ ] **Step 5: Commit do runtime Chat**

```powershell
git add business\package.json business\start.js business\lib\startRuntime.test.js
git commit -m "fix(voltchat): pin embedded uvicorn worker count"
```

### Task 6: Verificação integrada e documentação operacional

**Files:**
- Modify if necessary: `docs/superpowers/specs/2026-08-14-volt-core-shared-worker-design.md`
- Modify if present: `business/volt_core/README.md`

- [ ] **Step 1: Executar as suítes isoladas**

```powershell
cmd /c node --test src\modules\integrations\worker.test.js src\modules\integrations\outboxProcessing.test.js src\middlewares\requestObservability.test.js
```

Expected: zero failures.

- [ ] **Step 2: Executar a suíte completa do Volt Core**

```powershell
cmd /c npm test
```

Working directory: `business/volt_core`.

Expected: 148 testes anteriores mais os novos, zero failures.

- [ ] **Step 3: Executar os testes do agregador business**

```powershell
cmd /c npm test
```

Working directory: `business`.

Expected: Core e testes do proxy/runtime, zero failures.

- [ ] **Step 4: Executar builds**

```powershell
cmd /c npm run build
```

Executar primeiro em `business/volt_core` e depois em `business`.

Expected: ambos terminam com exit code 0.

- [ ] **Step 5: Verificar sintaxe e diff**

```powershell
node --check business\start.js
node --check business\volt_core\src\modules\integrations\worker.js
git diff --check
git status -sb
```

Expected: sintaxe válida, diff sem whitespace errors e somente arquivos planejados modificados.

- [ ] **Step 6: Documentar variáveis do deploy**

Registrar no README do Core:

```text
VOLT_CORE_JOB_POLL_MS=3000
VOLT_CORE_WORKER_IDLE_MAX_MS=60000
VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR=2
VOLT_CORE_WORKER_JITTER_RATIO=0.15
VOLT_CORE_HTTP_LOG_MODE=slow-errors
WEB_CONCURRENCY=1
```

Registrar também que o Start Command do serviço `business` é `node start.js`.

- [ ] **Step 7: Commit final de documentação**

```powershell
git add business\volt_core\README.md docs\superpowers\specs\2026-08-14-volt-core-shared-worker-design.md
git commit -m "docs(volt-core): document adaptive worker runtime"
```

- [ ] **Step 8: Push e validação do staging**

```powershell
git push origin voltdev
```

Depois do deploy:

1. Confirmar `/api/core/health` com banco e worker `ok`.
2. Confirmar `currentPollMs` crescendo até o teto em repouso.
3. Observar pelo menos dois minutos sem falso `integration.outbox.completed`.
4. Criar uma venda curta e confirmar um único evento real.
5. Confirmar fila sem `pending`, `retrying` ou `dead_letter` inesperado.
6. Observar CPU e RSS no Render por duas a seis horas.
