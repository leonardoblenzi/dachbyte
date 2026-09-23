# Hardening de Estoque e Calculadora ML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os limites de autorização, revisão, credenciais e cálculo identificados no fluxo de Estoque e na Calculadora ML.

**Architecture:** O job de estoque levará somente dados não sensíveis e resolverá credenciais pelo `accountKey` no worker. A pré-condição de estoque e a propriedade passam a falhar fechadas. A Calculadora aplica a autorização no roteador, valida o contexto da conta e trata a cotação do ML como requisito no modo ML, preservando contexto logístico e escapando valores da UI.

**Tech Stack:** Node.js, Express, Bull/Redis, `node:test`, JavaScript no navegador.

---

### Task 1: Reconstruir a Etapa 4 no worktree e cobrir as proteções de Estoque

**Files:**
- Copy: `apps/seller-ml/{controllers,services,public,views,routes,tests}` da Etapa 4 aprovada
- Modify: `apps/seller-ml/services/estoqueAtualizacaoService.js`
- Modify: `apps/seller-ml/services/estoqueAtualizacaoQueueService.js`
- Modify: `apps/seller-ml/tests/estoque-atualizacao-service.test.js`
- Create: `apps/seller-ml/tests/estoque-atualizacao-queue.test.js`

- [ ] **Step 1: Escrever testes que falham para snapshot e proprietário**

```js
test("bloqueia envio sem estoque revisado", () => {
  const change = normalizeRequestedChange({ mlb: "MLB123456789", new_stock: 8 });
  const result = preflightChange(change, activeRow(3), { sellerId: "10", multiOrigin: false });
  assert.equal(result.status, "invalid");
});

test("nao considera item sem seller_id como pertencente", () => {
  assert.equal(ownershipMatches({ id: "MLB123456789" }, "10"), false);
});
```

- [ ] **Step 2: Rodar para comprovar RED**

Run: `node --test apps/seller-ml/tests/estoque-atualizacao-service.test.js`

Expected: FAIL porque a prévia sem quantidade ainda fica `ready` e o proprietário sem vendedor ainda é aceito.

- [ ] **Step 3: Implementar a validação fechada**

```js
if (change.expected_current_stock == null) {
  return { ...base, status: "invalid", message: "A revisão do estoque é obrigatória antes do envio." };
}

function ownershipMatches(item, sellerId) {
  const owner = String(item?.seller_id || item?.seller?.id || "").trim();
  return Boolean(owner) && owner === String(sellerId);
}
```

- [ ] **Step 4: Escrever teste que falha para payload sem credenciais**

```js
test("enfileira somente identificadores e dados não sensíveis", async () => {
  const job = await enqueueStockUpdateJob({
    accessToken: "secret-access-token", mlCreds: { refresh_token: "secret-refresh-token" },
    accountKey: "account-1", changes: [{ mlb: "MLB123456789", expected_current_stock: 1, new_stock: 2 }],
  });
  assert.equal(job.data.accessToken, undefined);
  assert.equal(job.data.mlCreds, undefined);
});
```

- [ ] **Step 5: Rodar para comprovar RED**

Run: `node --test apps/seller-ml/tests/estoque-atualizacao-queue.test.js`

Expected: FAIL porque o payload inclui `accessToken` e `mlCreds`.

- [ ] **Step 6: Resolver credenciais no worker e manter retry seguro**

```js
const credentials = await resolveMlCredentialsForAccount(job.data.accountKey);
const result = await processStockChanges({
  accessToken: credentials.accessToken,
  mlCreds: credentials.mlCreds,
  changes: job.data.changes || [],
});
```

Remover `accessToken` e `mlCreds` de `queue.add`, de `retryFailed` e dos caminhos de auditoria. Reutilizar o serviço de credenciais já empregado pelo processo web, sem registrar valores secretos.

- [ ] **Step 7: Rodar GREEN**

Run: `node --test apps/seller-ml/tests/estoque-atualizacao-service.test.js apps/seller-ml/tests/estoque-atualizacao-queue.test.js`

Expected: PASS, sem tokens nos dados do job.

### Task 2: Autorizar e tornar confiável a Calculadora

**Files:**
- Modify: `apps/seller-ml/routes/financeiroMlRoutes.js`
- Modify: `apps/seller-ml/controllers/FinanceiroMlCalculatorController.js`
- Modify: `apps/seller-ml/services/financeiroMlCalculatorService.js`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Create: `apps/seller-ml/tests/financeiro-ml-calculadora-service.test.js`

- [ ] **Step 1: Escrever testes RED para conta e tarifa indisponível**

```js
test("rejeita calculadora sem conta selecionada", async () => {
  await assert.rejects(() => service.calculate({}, { mlCreds: {}, accountKey: null }), /Conta Mercado Livre/);
});

test("não converte indisponibilidade da tarifa ML em comissão zero", async () => {
  await assert.rejects(() => service.calculate(validMlBody, validContext), /tarifa.*indisponível/i);
});
```

- [ ] **Step 2: Rodar para comprovar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-service.test.js`

Expected: FAIL porque contexto nulo cai em `default` e `fetchListingFee` captura o erro como `null`.

- [ ] **Step 3: Implementar autorização e validações explícitas**

```js
router.get("/calculator/lookup", allowLegacyUntilConfigured("ml.precificacao.margem"), controller.lookup);
router.post("/calculator/calculate", allowLegacyUntilConfigured("ml.precificacao.margem"), controller.calculate);

if (!normalizedAccountKey(context.accountKey)) {
  throw Object.assign(new Error("Conta Mercado Livre não identificada."), { statusCode: 409 });
}
```

Exportar e reutilizar o middleware de módulo já usado em `htmlRoutes`, sem duplicar sua regra. Quando `use_ml_fee` estiver ativo, lançar erro 502/503 para ausência ou falha de `listing_prices`; o modo manual continua aceitando comissão digitada.

- [ ] **Step 4: Propagar contexto logístico pela cotação**

```js
await fetchListingFee(state, {
  price,
  categoryId,
  listingTypeId,
  shippingMode: item.shipping?.mode,
  logisticType: item.shipping?.logistic_type,
  dimensions: item.dimensions,
});
```

Preservar esses campos também nas cotações do solver. Encapsular a montagem de query para que somente campos existentes sejam enviados.

- [ ] **Step 5: Remover interpolação HTML de valores externos**

```js
const option = document.createElement("option");
option.value = row.key;
option.textContent = `${row.mlb} — ${row.sku || "Sem SKU"}`;
select.append(option);
```

- [ ] **Step 6: Rodar GREEN**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-service.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS, incluindo casos de conta ausente e erro de tarifa.

### Task 3: Revisão, regressão e entrega

**Files:**
- Verify: todos os arquivos alterados nas tarefas 1 e 2

- [ ] **Step 1: Verificação estática**

Run: `git diff --check` e `node --check` em todos os arquivos JavaScript alterados.

Expected: exit 0.

- [ ] **Step 2: Regressão focada**

Run: `node --test apps/seller-ml/tests/estoque-atualizacao-preview.test.js apps/seller-ml/tests/estoque-atualizacao-service.test.js apps/seller-ml/tests/estoque-atualizacao-queue.test.js apps/seller-ml/tests/financeiro-ml-calculadora-service.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: zero falhas.

- [ ] **Step 3: Revisão de conformidade por agente**

Conferir, linha a linha, os critérios de aceitação da especificação e que não foi introduzida chamada de escrita do ML na Calculadora.

- [ ] **Step 4: Revisão de qualidade por agente**

Revisar vazamento de segredos, escopo por conta, erros tratados e regressões de navegador. Corrigir qualquer achado antes da entrega.
