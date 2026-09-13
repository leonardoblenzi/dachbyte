# Fase E — conclusão do fluxo óptico Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir receita vinculada a qualquer cliente paginado e garantir que venda óptica crie, exiba e cancele OP/OS de forma verificável.

**Architecture:** O modal passará a tratar a seleção de cliente como `customerId` + nome de exibição e consultará o recurso paginado já existente. Um teste de integração isolará a cadeia persistida da venda óptica até a listagem de OS; a correção será aplicada na primeira fronteira que devolver dados inconsistentes, preservando a transação única já usada pela venda.

**Tech Stack:** React, Vite, Node.js `node:test`, Express, PostgreSQL e RLS por empresa.

---

## Estrutura de arquivos

- Modificar: `business/volt_core/src/client/modals/ActionModalSections.jsx` — novo campo de lookup assíncrono, sem carregar a base completa.
- Modificar: `business/volt_core/src/client/main.jsx` — fornecer busca paginada e incluir o identificador selecionado no estado do modal.
- Modificar: `business/volt_core/src/client/extensions/optical/modalConfig.js` — configurar Receita com lookup obrigatório por `customerId`.
- Modificar: `business/volt_core/src/client/extensions/optical/handlers.js` — enviar a referência de cliente ao endpoint.
- Modificar: `business/volt_core/src/modules/core/preGoLiveRegression.test.js` — regressões estruturais de autocomplete e contrato de criação/cancelamento óptico.
- Modificar, somente se a regressão mostrar falha: `business/volt_core/src/modules/core/runtime/services/dataQueryService.js` ou `business/volt_core/src/client/workspace/mapWorkspaceToAppData.js` — ajustar a fronteira que não propaga a OS.

### Task 1: Provar o contrato de OP/OS antes de alterar comportamento

**Files:**
- Modify: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever a regressão que exige a cadeia óptica completa**

Adicionar teste que lê `salesService.js`, `extensions/optical/backend/saleHooks.js`, `opticalService.js`, `dataQueryService.js` e `mapWorkspaceToAppData.js`, exigindo os contratos abaixo:

```js
assert.match(saleHooks, /createOpticalOrderWithClient\(client, companyId, sale, customer, items, optical, actorUserId\)/);
assert.match(opticalService, /insert into volt_core\.service_orders/);
assert.match(opticalService, /sale_id, prescription_id, laboratory_id, optical_order_id/);
assert.match(dataQuery, /data: \{ serviceOrders: result\.rows \}/);
assert.match(mapper, /if \(hasWorkspaceField\(workspace, "serviceOrders"\)\) next\.serviceOrders/);
assert.match(saleHooks, /update volt_core\.service_orders set status = 'canceled'/);
```

- [ ] **Step 2: Executar a regressão e registrar o resultado inicial**

Run: `cmd /c node --test src\\modules\\core\\preGoLiveRegression.test.js`

Expected: a nova prova falha se qualquer elo OP/OS ou cancelamento não estiver presente.

- [ ] **Step 3: Corrigir somente a fronteira que a regressão identificar**

Se a criação falhar, manter `createOpticalOrderWithClient` dentro do hook `sale.afterCreated` e repassar `extensionPayloads["vertical.optical"]`. Se a resposta falhar, preservar o shape `{ data: { serviceOrders } }`. Se o mapper falhar, preservar `recordId: order.id`, `id: \`OS-${order.number}\`` e `statusKey`.

```js
return {
  data: { serviceOrders: result.rows },
  pagination: result.pagination,
  summary: { ...summaryResult.rows[0], queueRows: overviewResult.rows },
};
```

- [ ] **Step 4: Executar a regressão após a correção**

Run: `cmd /c node --test src\\modules\\core\\preGoLiveRegression.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar o contrato de OP/OS**

```bash
git add business/volt_core/src/modules/core/preGoLiveRegression.test.js business/volt_core/src/modules/core/runtime/services/dataQueryService.js business/volt_core/src/client/workspace/mapWorkspaceToAppData.js
git commit -m "test(volt-core): cover optical order lifecycle"
```

### Task 2: Implementar seleção paginada de cliente na Receita

**Files:**
- Modify: `business/volt_core/src/client/modals/ActionModalSections.jsx`
- Modify: `business/volt_core/src/client/main.jsx`
- Modify: `business/volt_core/src/client/extensions/optical/modalConfig.js`
- Modify: `business/volt_core/src/client/extensions/optical/handlers.js`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever a regressão do lookup por identificador**

Adicionar teste que exige `customer_lookup`, `customerId`, `loadResource("customers"` e que a configuração de Receita não usa `type: "select"` nem `customerOptions`.

```js
assert.match(modalSections, /field\.type === "customer_lookup"/);
assert.match(main, /loadResource\("customers", \{ page: 1, pageSize: 20, search/);
assert.match(opticalModal, /name: "customerId"/);
assert.match(opticalModal, /type: "customer_lookup"/);
assert.doesNotMatch(prescriptionBlock, /type: "select", options: customerOptions/);
assert.match(opticalHandler, /customerId: values\.customerId/);
```

- [ ] **Step 2: Executar a regressão para confirmar RED**

Run: `cmd /c node --test src\\modules\\core\\preGoLiveRegression.test.js`

Expected: FAIL porque `customer_lookup` ainda não existe.

- [ ] **Step 3: Adicionar o campo de lookup sem reverter a paginação**

Em `ActionModalSections.jsx`, implementar `customer_lookup` com texto pesquisável, lista de resultados e seleção que atualiza ambos os campos:

```jsx
onClick={() => {
  onValueChange(field.name, option.name);
  onValueChange(field.idField, option.id);
  setLookupOpen(false);
}}
```

Em `ActionModal`, manter uma lista local de resultados e aplicar debounce de 240 ms para `loadRuntimeResource("customers", { page: 1, pageSize: 20, search: query }, { silent: true })`. Passar os resultados ao campo; não utilizar `data.customers` como catálogo completo.

Em `modalConfig.js`, definir:

```js
{ name: "customer", label: "Cliente", type: "customer_lookup", idField: "customerId", required: true, wide: true }
```

e defaults com `customerId: payload.customerId || ""`. Em `handlers.js`, incluir `customerId: values.customerId || null` no POST/PATCH.

- [ ] **Step 4: Rodar o teste focal em GREEN**

Run: `cmd /c node --test src\\modules\\core\\preGoLiveRegression.test.js`

Expected: PASS, com o select antigo ausente da configuração de Receita.

- [ ] **Step 5: Commitar o autocomplete de Receita**

```bash
git add business/volt_core/src/client/modals/ActionModalSections.jsx business/volt_core/src/client/main.jsx business/volt_core/src/client/extensions/optical/modalConfig.js business/volt_core/src/client/extensions/optical/handlers.js business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "fix(volt-core): search paged customers in optical prescriptions"
```

### Task 3: Verificação integrada e handoff

**Files:**
- Verify only: `business/volt_core`

- [ ] **Step 1: Executar a suíte inteira**

Run: `cmd /c npm test`

Expected: exit 0, incluindo as regressões novas.

- [ ] **Step 2: Executar build e verificação de whitespace**

Run:

```bash
cmd /c npm run build
git diff --check
```

Expected: build exit 0; aviso de tamanho de chunk é permitido, erro não.

- [ ] **Step 3: Retestar no staging após deploy**

1. Pesquisar o cliente QA fora da primeira página no modal Receita e salvar.
2. Fazer venda com `QA-FE-FRAME-001` e `QA-FE-LENS-001`.
3. Confirmar OP e OS na tela de produção, recebível e baixa de estoque.
4. Cancelar pelo pedido e confirmar OP/OS canceladas, recebível cancelado e estoque restaurado.

- [ ] **Step 4: Commit final e push**

```bash
git status -sb
git push origin voltdev
```
