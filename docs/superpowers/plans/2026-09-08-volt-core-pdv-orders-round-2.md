# Volt Core PDV And Orders Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preservar o rascunho da venda entre navegacao e recarregamento, reposicionar a previsao de entrega no checkout e concluir a experiencia operacional da aba Pedidos.

**Architecture:** O rascunho optico sera persistido em `sessionStorage` por empresa e operador por meio de um adaptador puro e testavel, mantendo o componente como fonte reativa do estado. O PDV continuara enviando `promisedDeliveryDate` no mesmo payload, mas o campo sera apresentado apenas no checkout de pagamento na entrega. A lista de pedidos separara andamento, entrega e financeiro, mantendo `Concluir retirada` como acao primaria e agrupando operacoes administrativas em menu contextual.

**Tech Stack:** React 19, JavaScript, Vite, Node.js test runner, CSS existente do Volt Core.

**Execution status:** Implementado em `voltdev`; testes automatizados e build aprovados. O QA em navegador foi dispensado pelo usuario nesta rodada.

---

### Task 1: Consolidar os cards de produto e cliente

**Files:**
- Modify: `business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`
- Test: `business/volt_core/src/modules/core/extensionArchitecture.test.js`

- [ ] **Step 1: Confirmar o contrato de regressao que evita duplicidade**

Manter o teste que exige resultados ocultos depois da selecao e os comandos explicitos para troca:

```js
test("optical PDV shows one selected context card instead of duplicating lookup results", () => {
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");

  assert.match(pdv, /const visibleResults = !selectedProduct && productQuery\.trim\(\) \? visibleProducts\.slice\(0, 8\) : \[\]/);
  assert.match(pdv, /const visibleCustomers = !customer && normalizedQuery/);
  assert.match(pdv, /Trocar produto/);
  assert.match(pdv, /Trocar cliente/);
});
```

- [ ] **Step 2: Executar o teste de contrato**

Run: `npm test -- --test-name-pattern="one selected context card"`

Expected: PASS.

- [ ] **Step 3: Revisar a implementacao local**

Confirmar que `visibleResults` e `visibleCustomers` viram listas vazias quando existe selecao, que cada contexto mostra um unico card completo e que `Trocar produto`/`Trocar cliente` limpa a selecao.

- [ ] **Step 4: Commitar a correcao isolada**

```bash
git add business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx business/volt_core/src/modules/core/preGoLiveRegression.test.js business/volt_core/src/modules/core/extensionArchitecture.test.js
git commit -m "fix(volt-core): consolidate PDV lookup selections"
```

### Task 2: Persistir o rascunho por empresa e operador

**Files:**
- Create: `business/volt_core/src/client/extensions/optical/opticalSaleDraftStorage.js`
- Modify: `business/volt_core/src/client/extensions/optical/OpticalSalesPdv.jsx`
- Modify: `business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx`
- Modify: `business/volt_core/src/client/main.jsx`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever testes falhando para chave, leitura, gravacao e limpeza**

Adicionar um contrato que importe o adaptador e valide o escopo sem acessar o navegador:

```js
test("optical sale draft storage is scoped by company and operator", async () => {
  const module = await import("../../client/extensions/optical/opticalSaleDraftStorage.js");
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const scope = { companyId: "company-a", operatorId: "user-a" };
  const draft = { customerId: "customer-a", cart: [{ id: "product-a" }] };

  module.writeOpticalSaleDraft(storage, scope, draft);
  assert.deepEqual(module.readOpticalSaleDraft(storage, scope), draft);
  assert.equal(module.readOpticalSaleDraft(storage, { companyId: "company-b", operatorId: "user-a" }), null);
  module.clearOpticalSaleDraft(storage, scope);
  assert.equal(module.readOpticalSaleDraft(storage, scope), null);
});
```

- [ ] **Step 2: Executar o teste e verificar a falha**

Run: `npm test -- --test-name-pattern="draft storage is scoped"`

Expected: FAIL porque `opticalSaleDraftStorage.js` ainda nao existe.

- [ ] **Step 3: Criar o adaptador de sessao**

Implementar funcoes puras, tolerantes a storage indisponivel ou JSON corrompido:

```js
const DRAFT_STORAGE_PREFIX = "volt_core_optical_sale_draft";

function opticalSaleDraftKey({ companyId, operatorId } = {}) {
  return `${DRAFT_STORAGE_PREFIX}:${companyId || "company"}:${operatorId || "operator"}`;
}

function readOpticalSaleDraft(storage, scope) {
  try {
    return JSON.parse(storage?.getItem(opticalSaleDraftKey(scope)) || "null");
  } catch (_error) {
    return null;
  }
}

function writeOpticalSaleDraft(storage, scope, draft) {
  try {
    storage?.setItem(opticalSaleDraftKey(scope), JSON.stringify(draft));
  } catch (_error) {
    // Restricted browser modes may disable session storage.
  }
}

function clearOpticalSaleDraft(storage, scope) {
  try {
    storage?.removeItem(opticalSaleDraftKey(scope));
  } catch (_error) {
    // Keep the in-memory workflow usable when persistence is unavailable.
  }
}

export { clearOpticalSaleDraft, opticalSaleDraftKey, readOpticalSaleDraft, writeOpticalSaleDraft };
```

- [ ] **Step 4: Expor o escopo atual no runtime do frontend**

Adicionar ao `runtimeData` de `AppShell`:

```js
draftScope: {
  companyId: selectedCompanyId,
  operatorId: user?.uid || user?.id || user?.email || "current",
},
```

Incluir `selectedCompanyId`, `user?.email`, `user?.id` e `user?.uid` nas dependencias do `useMemo`.

- [ ] **Step 5: Inicializar e sincronizar o rascunho persistido**

Em `OpticalSalesPdv.jsx`, ler o rascunho no inicializador e completar campos ausentes com o formato atual:

```js
const draftScope = runtimeData?.draftScope || {};
const storage = typeof window === "undefined" ? null : window.sessionStorage;
const [draft, setDraft] = useState(() => ({
  ...createEmptyOpticalSaleDraft(),
  ...(readOpticalSaleDraft(storage, draftScope) || {}),
}));

useEffect(() => {
  writeOpticalSaleDraft(storage, draftScope, draft);
}, [draft, draftScope.companyId, draftScope.operatorId]);
```

Quando o escopo mudar, carregar somente o rascunho daquele escopo. Depois de uma venda concluida, remover a chave antes de criar o novo rascunho.

- [ ] **Step 6: Adicionar descarte explicito e seguro**

Passar `onClearDraft` para a view e exibir `Limpar venda` somente quando houver dados. A acao deve pedir confirmacao e entao executar:

```js
clearOpticalSaleDraft(storage, draftScope);
setDraft(createEmptyOpticalSaleDraft());
setProductQuery("");
setCustomerQuery("");
setReviewing(false);
setError("");
```

- [ ] **Step 7: Executar testes focados**

Run: `npm test -- --test-name-pattern="draft storage|one selected context card"`

Expected: PASS.

- [ ] **Step 8: Commitar a persistencia**

```bash
git add business/volt_core/src/client/extensions/optical/opticalSaleDraftStorage.js business/volt_core/src/client/extensions/optical/OpticalSalesPdv.jsx business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx business/volt_core/src/client/main.jsx business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(volt-core): persist optical sale drafts"
```

### Task 3: Mover a previsao de entrega para o checkout

**Files:**
- Modify: `business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever o contrato visual falhando**

Adicionar verificacoes de que Cliente nao recebe mais props de entrega e o checkout renderiza o campo condicional:

```js
test("delivery date belongs to delivery checkout instead of customer section", () => {
  const pdv = source("src/client/extensions/optical/OpticalSalesPdvView.jsx");

  assert.match(pdv, /title="Cliente"/);
  assert.doesNotMatch(pdv, /title="Cliente e entrega"/);
  assert.match(pdv, /isPaymentOnDelivery[\s\S]*Previsao de entrega \*[\s\S]*type="date"/);
  assert.match(pdv, /value=\{draft\.promisedDate\}/);
  assert.match(pdv, /onFieldChange\("promisedDate", event\.target\.value\)/);
});
```

- [ ] **Step 2: Executar o teste e verificar a falha**

Run: `npm test -- --test-name-pattern="delivery date belongs"`

Expected: FAIL porque o campo ainda pertence a `OpticalSaleCustomer`.

- [ ] **Step 3: Simplificar a secao Cliente**

Alterar a assinatura para:

```js
function OpticalSaleCustomer({ customer, customerQuery, customers, isOptical, needsCustomerForOptical, onAction, onCustomerQueryChange, onCustomerSelect })
```

Usar `SectionTitle` com `title="Cliente"`, remover o campo de data e retirar as props antigas na chamada do componente.

- [ ] **Step 4: Renderizar a data somente em Pagar na entrega**

Logo depois de `.delivery-payment-notice`, inserir:

```jsx
<label className="field delivery-date-field">
  <span>Previsao de entrega *</span>
  <input
    required
    type="date"
    value={draft.promisedDate}
    onChange={(event) => onFieldChange("promisedDate", event.target.value)}
  />
</label>
```

Manter `promisedDate` no rascunho ao alternar para `Pagar agora`; somente a renderizacao deve ser condicional.

- [ ] **Step 5: Executar testes focados**

Run: `npm test -- --test-name-pattern="delivery date belongs|delivery payment UI contract"`

Expected: PASS.

- [ ] **Step 6: Commitar o ajuste de checkout**

```bash
git add business/volt_core/src/client/extensions/optical/OpticalSalesPdvView.jsx business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "fix(volt-core): place delivery date in checkout"
```

### Task 4: Finalizar a linha e os filtros de Pedidos

**Files:**
- Modify: `business/volt_core/src/client/main.jsx`
- Modify: `business/volt_core/src/client/styles.css`
- Test: `business/volt_core/src/modules/core/preGoLiveRegression.test.js`

- [ ] **Step 1: Escrever o contrato falhando da listagem**

Adicionar verificacoes para as duas dimensoes de status, coluna de entrega e menu secundario:

```js
test("orders separate operation, delivery date, finance and secondary actions", () => {
  const main = source("src/client/main.jsx");

  assert.match(main, /columns=\{\["Pedido", "Data", "Cliente", "Itens", "Entrega", "Andamento", "Total", "Financeiro", "Acoes"\]\}/);
  assert.match(main, /Aguardando pagamento na entrega/);
  assert.match(main, /Pronto para retirada/);
  assert.match(main, /Concluido/);
  assert.match(main, /Concluir retirada/);
  assert.match(main, /<MoreOptionsMenu/);
});
```

- [ ] **Step 2: Executar o teste e verificar a falha**

Run: `npm test -- --test-name-pattern="orders separate operation"`

Expected: FAIL porque a previsao ainda esta abaixo do cliente e todas as acoes estao expostas.

- [ ] **Step 3: Normalizar os estados apresentados**

Usar andamento somente para producao e entrega:

```js
function saleOperationalStatus(sale) {
  if (normalizeFilterText(sale.status) === "cancelada") return "Cancelado";
  if (sale.statusKey === "pending_delivery" && sale.opticalOrderStatus === "ready") return "Pronto para retirada";
  if (sale.statusKey === "pending_delivery") return "Em producao";
  if (sale.statusKey === "finalized") return "Concluido";
  return sale.status;
}
```

Usar financeiro para a pendencia de pagamento:

```jsx
<span className="sale-financial-status">
  <strong>Aguardando pagamento na entrega</strong>
  <small>{sale.total} a receber</small>
</span>
```

- [ ] **Step 4: Criar uma coluna propria para Entrega**

Alterar as colunas para incluir `Entrega` e renderizar:

```jsx
<td className="entity-main-cell">
  <strong>{sale.promisedDeliveryDate ? formatShortDate(sale.promisedDeliveryDate) : "Sem previsao"}</strong>
  <small>{sale.statusKey === "pending_delivery" ? "Previsao do pedido" : "Entrega concluida"}</small>
</td>
```

Remover a previsao da celula Cliente para que nome e prazo sejam escaneaveis separadamente.

- [ ] **Step 5: Ajustar filtros para os estados visiveis**

Usar:

```js
const saleFilters = [
  "Todos",
  "Em producao",
  "Pronto para retirada",
  "Aguardando pagamento na entrega",
  "Concluido",
  "Cancelado",
].map((item) => ({ value: item, label: item }));
```

O filtro deve comparar tanto `saleOperationalStatus(sale)` quanto o texto financeiro derivado, sem usar apenas o nome bruto do metodo de pagamento.

- [ ] **Step 6: Manter somente a acao principal exposta**

Quando pronto, mostrar `Concluir retirada`. Agrupar `Detalhar`, `Editar` e `Cancelar`/`Excluir` em `MoreOptionsMenu`, reutilizando os mesmos callbacks e confirmacoes atuais:

```jsx
<span className="row-actions">
  {readyForDelivery ? (
    <button className="table-action table-action--primary" type="button" onClick={() => setDeliverySale(sale)}>
      Concluir retirada
    </button>
  ) : null}
  <MoreOptionsMenu items={secondarySaleActions({ sale, canceled, onAction, onDetail: setSelectedSale })} />
</span>
```

Criar `secondarySaleActions` ao lado de `SalesOrders`, retornando exatamente as acoes existentes e preservando as confirmacoes de exclusao e cancelamento.

- [ ] **Step 7: Ajustar o menu para uso em tabelas**

Adicionar uma variante compacta em `styles.css`, com menu alinhado a direita, `z-index` acima da tabela e largura minima suficiente para os rotulos. Garantir que a linha nao aumente de altura enquanto o menu estiver fechado.

- [ ] **Step 8: Executar testes focados**

Run: `npm test -- --test-name-pattern="orders separate operation|delivery payment UI contract"`

Expected: PASS.

- [ ] **Step 9: Commitar a listagem de Pedidos**

```bash
git add business/volt_core/src/client/main.jsx business/volt_core/src/client/styles.css business/volt_core/src/modules/core/preGoLiveRegression.test.js
git commit -m "feat(volt-core): clarify order delivery workflow"
```

### Task 5: Verificacao integrada e documentacao

**Files:**
- Modify: `docs/superpowers/plans/2026-09-08-volt-core-delivery-payment-and-pdv.md`

- [ ] **Step 1: Executar toda a regressao**

Run: `npm test`

Expected: todos os testes passam, incluindo persistencia, selecao unica, previsao no checkout e Pedidos.

- [ ] **Step 2: Executar o build de producao**

Run: `npm run build`

Expected: Vite conclui sem erros e gera `dist`.

- [ ] **Step 3: Verificar formatacao do diff**

Run: `git diff --check`

Expected: sem espacos finais ou marcadores de conflito.

- [ ] **Step 4: Fazer QA manual no navegador**

Validar no ambiente optico:

1. Selecionar cliente, adicionar produto, navegar para Pedidos e voltar; o rascunho permanece.
2. Recarregar a pagina; o rascunho da mesma empresa e operador permanece.
3. Trocar de empresa; o rascunho nao vaza entre empresas.
4. Usar `Limpar venda`; confirmar que somente o rascunho atual e removido.
5. Alternar entre `Pagar agora` e `Pagar na entrega`; a data aparece somente na segunda opcao e preserva o valor digitado.
6. Criar pedido e verificar `Entrega`, `Em producao` e `Aguardando pagamento na entrega` na linha.
7. Marcar producao pronta e concluir retirada; verificar `Concluido` e financeiro atualizado.
8. Conferir que Detalhar, Editar e Cancelar continuam acessiveis no menu secundario.

- [ ] **Step 5: Atualizar o plano mestre**

Marcar persistencia do rascunho, previsao no checkout e acabamento de Pedidos como concluidos, registrando os comandos de teste e build executados.

- [ ] **Step 6: Commitar a verificacao documental**

```bash
git add docs/superpowers/plans/2026-09-08-volt-core-delivery-payment-and-pdv.md docs/superpowers/plans/2026-09-08-volt-core-pdv-orders-round-2.md
git commit -m "docs(volt-core): record PDV and orders QA"
```
