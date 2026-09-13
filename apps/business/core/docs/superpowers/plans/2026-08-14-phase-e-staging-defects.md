# Phase E Staging Defects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a OS óptica aparecer na coleção paginada, preservar/rejeitar datas de receita de forma determinística e atualizar a venda imediatamente após cancelamento.

**Architecture:** Corrigir os contratos nas suas fronteiras: o hook óptico recebe um cliente de banco com fallback seguro, a normalização de datas deixa de aceitar valores impossíveis silenciosamente e o handler de cancelamento aplica a resposta confirmada antes de reconciliar as coleções server-side. As mudanças permanecem dentro de `business/volt_core` e não exigem migration.

**Tech Stack:** Node.js 20+, node:test, Express, PostgreSQL, React 19, Vite.

---

### Task 1: Restaurar a coleção paginada de OS

**Files:**
- Modify: `business/volt_core/src/extensions/optical/backend/entityHooks.js`
- Modify: `business/volt_core/src/modules/core/commercialPhaseE.test.js`

- [ ] **Step 1: Escrever o teste que reproduz a ausência de cliente explícito**

Adicionar um teste que substitui temporariamente `coreContracts.db.query`, chama `decorateServiceOrders({ companyId, rows })` sem `client` e exige que a linha receba `opticalOrderId`:

```js
test("service order decorator falls back to the Core database client", async () => {
  const originalQuery = coreContracts.db.query;
  coreContracts.db.query = async () => ({ rows: [{ id: "order-41", opticalOrderId: "optical-41" }] });
  try {
    const rows = [{ id: "order-41" }];
    await opticalEntityHooks.decorateServiceOrders({ companyId: "company-a", rows });
    assert.equal(rows[0].opticalOrderId, "optical-41");
  } finally {
    coreContracts.db.query = originalQuery;
  }
});
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test src/modules/core/commercialPhaseE.test.js`

Expected: FAIL com erro equivalente a `Cannot read properties of undefined (reading 'query')`.

- [ ] **Step 3: Implementar o fallback mínimo**

Importar a interface pública do Core e usar o valor padrão somente quando o hook não recebe um cliente transacional:

```js
const { db } = require("../../../platform/extensions/coreContracts");

async function decorateServiceOrders({ client = db, companyId, rows }) {
  // corpo atual preservado
}
```

- [ ] **Step 4: Confirmar GREEN**

Run: `node --test src/modules/core/commercialPhaseE.test.js`

Expected: todos os testes do arquivo passam e a regressão comprova os dois contratos: fallback e cliente explícito.

- [ ] **Step 5: Commitar a correção da OS**

```bash
git add business/volt_core/src/extensions/optical/backend/entityHooks.js business/volt_core/src/modules/core/commercialPhaseE.test.js
git commit -m "fix(volt-core): restore paged service orders"
```

### Task 2: Endurecer datas da receita óptica

**Files:**
- Modify: `business/volt_core/src/extensions/optical/backend/opticalService.js`
- Modify: `business/volt_core/src/modules/core/runtime/services/opticalService.js`
- Modify: `business/volt_core/src/client/modals/ActionModalSections.jsx`
- Modify: `business/volt_core/src/modules/core/commercialPhaseE.test.js`
- Modify: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever regressões para datas válidas e impossíveis**

Expor `normalizeDateInput` nos dois serviços e testar:

```js
assert.equal(opticalService.normalizeDateInput("2026-08-14"), "2026-08-14");
assert.equal(opticalService.normalizeDateInput("14/08/2026"), "2026-08-14");
assert.equal(opticalService.normalizeDateInput(""), null);
assert.throws(
  () => opticalService.normalizeDateInput("2026-02-31"),
  (error) => error.statusCode === 400 && error.code === "OPTICAL_DATE_INVALID",
);
```

Adicionar também uma regressão estrutural exigindo que campos `date` usem `onInput` no componente padrão do modal.

- [ ] **Step 2: Executar os testes e confirmar RED**

Run: `node --test src/modules/core/commercialPhaseE.test.js src/modules/core/preGoLiveRegression.test.js`

Expected: FAIL porque `normalizeDateInput` não é exportada, datas impossíveis ainda são aceitas e o input de data não possui captura explícita por `onInput`.

- [ ] **Step 3: Implementar validação estrita de calendário**

Nos dois serviços, preservar vazio/aliases como `null`, converter os formatos aceitos e validar ano, mês e dia com UTC. Para valor não vazio inválido, lançar:

```js
throw Object.assign(new Error("Data optica invalida"), {
  statusCode: 400,
  code: "OPTICAL_DATE_INVALID",
});
```

Exportar `normalizeDateInput` para o teste e manter todos os inserts/updates usando essa mesma função.

- [ ] **Step 4: Tornar o input de data explicitamente controlado**

No input padrão de `ActionModalSections.jsx`, usar `onInput` para `field.type === "date"` e manter `onChange` para os demais tipos:

```jsx
onInput={field.type === "date" ? (event) => onValueChange(field.name, event.currentTarget.value) : undefined}
onChange={field.type === "date" ? undefined : (event) => onValueChange(field.name, event.target.value)}
```

- [ ] **Step 5: Confirmar GREEN**

Run: `node --test src/modules/core/commercialPhaseE.test.js src/modules/core/preGoLiveRegression.test.js`

Expected: todos os testes passam; `2026-02-31` gera `OPTICAL_DATE_INVALID` e os dois serviços mantêm o mesmo contrato.

- [ ] **Step 6: Commitar a correção de datas**

```bash
git add business/volt_core/src/extensions/optical/backend/opticalService.js business/volt_core/src/modules/core/runtime/services/opticalService.js business/volt_core/src/client/modals/ActionModalSections.jsx business/volt_core/src/modules/core/commercialPhaseE.test.js business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "fix(volt-core): preserve optical prescription dates"
```

### Task 3: Atualizar a venda imediatamente após cancelamento

**Files:**
- Modify: `business/volt_core/src/client/runtime/runtimeListState.mjs`
- Modify: `business/volt_core/src/client/actions/handlers/shared.js`
- Modify: `business/volt_core/src/modules/core/commercialPhaseE.test.js`

- [ ] **Step 1: Escrever testes para a transição local e os recursos recarregados**

Adicionar ao módulo puro:

```js
const SALE_MUTATION_REFRESH_RESOURCES = Object.freeze(["sales", "serviceOrders", "opticalOrders"]);

function applyConfirmedSaleCancellation(current, targetId, sale = {}) {
  // substitui somente a venda cujo recordId/id corresponde a targetId
}
```

O teste deve exigir `status: "Cancelada"` para a venda afetada, preservar as demais e verificar a lista exata dos três recursos.

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `node --test src/modules/core/commercialPhaseE.test.js`

Expected: FAIL porque os exports e a atualização local ainda não existem.

- [ ] **Step 3: Implementar a atualização confirmada**

Implementar `applyConfirmedSaleCancellation` de forma imutável em `runtimeListState.mjs`. No handler, guardar a resposta da API e, para cancelamento de venda, aplicar:

```js
const response = await apiFetch(action.url, requestOptions);
if (values.collection === "sales" && operation !== "delete" && response?.sale) {
  setAppData((current) => applyConfirmedSaleCancellation(current, values.targetId, response.sale));
}
await refreshRuntimeWorkspace({
  resources: values.collection === "sales" ? SALE_MUTATION_REFRESH_RESOURCES : [],
});
```

- [ ] **Step 4: Confirmar GREEN**

Run: `node --test src/modules/core/commercialPhaseE.test.js`

Expected: todos os testes passam e a transição local não depende de trocar de aba.

- [ ] **Step 5: Commitar a atualização do cancelamento**

```bash
git add business/volt_core/src/client/runtime/runtimeListState.mjs business/volt_core/src/client/actions/handlers/shared.js business/volt_core/src/modules/core/commercialPhaseE.test.js
git commit -m "fix(volt-core): reconcile canceled optical sales"
```

### Task 4: Verificação integral

**Files:**
- Verify only: `business/volt_core`

- [ ] **Step 1: Executar os testes focais**

Run: `node --test src/modules/core/commercialPhaseE.test.js src/modules/core/preGoLiveRegression.test.js`

Expected: exit code 0 e zero falhas.

- [ ] **Step 2: Executar a suíte completa**

Run: `npm test`

Expected: exit code 0 e zero falhas.

- [ ] **Step 3: Executar o build**

Run: `npm run build`

Expected: exit code 0 e bundle Vite gerado sem erro.

- [ ] **Step 4: Validar sintaxe e whitespace**

Run: `node --check src/extensions/optical/backend/entityHooks.js`

Run: `node --check src/extensions/optical/backend/opticalService.js`

Run: `node --check src/modules/core/runtime/services/opticalService.js`

Run: `git diff --check`

Expected: todos retornam exit code 0.

- [ ] **Step 5: Revisar o escopo final**

Run: `git status -sb`

Run: `git diff --stat HEAD~3..HEAD`

Expected: somente arquivos dentro de `business/volt_core`; nenhuma migration e nenhum arquivo de outros módulos.

