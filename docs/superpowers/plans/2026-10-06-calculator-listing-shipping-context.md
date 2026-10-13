# Calculator listing shipping context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar o modo de envio real do MLB, distinguir quem paga o frete e identificar a cotação anterior à venda como estimativa.

**Architecture:** O lookup já fornece os atributos de envio. Uma regra pura transforma esses atributos em contexto legível e na seleção inicial da simulação. O navegador renderiza o contexto somente em “Usar anúncio” e mantém o valor do comprador opcional para ME1 e entrega a combinar.

**Tech Stack:** JavaScript CommonJS/browser, HTML, CSS, `node:test`.

---

### Task 1: Derivar contexto do anúncio

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.deepEqual(rules.listingShippingContext({ shipping_mode: "me2", logistic_type: "cross_docking", free_shipping: true, shipping_source: "users_shipping_options_free" }), {
  modeLabel: "Mercado Envios 2 (ME2)", logisticLabel: "Coleta", paymentLabel: "Frete grátis para o comprador", simulationMode: "mercado_envios", quoteStatus: "estimated",
});
assert.equal(rules.listingShippingContext({ shipping_mode: "me2", free_shipping: false }).simulationMode, "comprador");
assert.equal(rules.listingShippingContext({ shipping_mode: "me1", free_shipping: true }).simulationMode, "comprador");
assert.equal(rules.listingShippingContext({ shipping_mode: "not_specified", free_shipping: true }).simulationMode, "comprador");
assert.equal(rules.listingShippingContext({ shipping_mode: "me2", free_shipping: true, shipping_source: "unavailable" }).quoteStatus, "unavailable");
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque `listingShippingContext` não existe.

- [ ] **Step 3: Implementar regra**

```js
function listingShippingContext(item = {}) {
  const mode = String(item.shipping_mode || "").trim().toLowerCase();
  const logistic = String(item.logistic_type || "").trim().toLowerCase();
  const agreed = ["me1", "not_specified", "to_be_agreed"].includes(mode);
  const simulationMode = agreed ? "comprador" : item.free_shipping ? "mercado_envios" : "comprador";
  const modeLabel = ({ me2: "Mercado Envios 2 (ME2)", me1: "ME1 · logística própria", custom: "Envio personalizado", not_specified: "Entrega a combinar", to_be_agreed: "Entrega a combinar" })[mode] || "Modo não informado";
  const logisticLabel = ({ cross_docking: "Coleta", xd_drop_off: "Agência", drop_off: "Ponto de envio", fulfillment: "Full", self_service: "Flex", turbo: "Turbo" })[logistic] || "";
  const paymentLabel = agreed ? "Frete a definir na simulação" : item.free_shipping ? "Frete grátis para o comprador" : "Comprador paga o frete";
  const quoteStatus = simulationMode !== "mercado_envios" ? "not_applicable" :
    ["users_shipping_options_free", "items_shipping_options_free"].includes(item.shipping_source) ? "estimated" : "unavailable";
  return { modeLabel, logisticLabel, paymentLabel, simulationMode, quoteStatus };
}
```

Exportar no `api` existente.

- [ ] **Step 4: Rodar GREEN**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculator-rules.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: PASS.

### Task 2: Mostrar modo, pagador e estimativa no formulário

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

- [ ] **Step 1: Escrever testes RED de contrato**

```js
assert.match(html, /id="calc-listing-shipping-context"/);
assert.match(html, /id="calc-listing-shipping-mode"/);
assert.match(html, /id="calc-listing-shipping-payment"/);
assert.match(html, /id="calc-listing-shipping-quote"/);
assert.match(script, /rules\.listingShippingContext\(row\)/);
assert.match(script, /syncShippingMode\(shippingContext\.simulationMode\)/);
assert.match(css, /\.calc-listing-shipping-context\[hidden\]/);
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: FAIL nos novos IDs e na conexão da regra.

- [ ] **Step 3: Adicionar estrutura ao bloco Frete**

```html
<div id="calc-listing-shipping-context" class="calc-listing-shipping-context" hidden>
  <strong id="calc-listing-shipping-mode">Modo do anúncio</strong>
  <span id="calc-listing-shipping-payment"></span>
  <small id="calc-listing-shipping-quote"></small>
</div>
```

Inserir antes dos botões. Dar IDs aos dois botões e ao rótulo do custo do vendedor para texto específico no modo anúncio. Atualizar cache-bust do CSS/JS no HTML.

- [ ] **Step 4: Conectar ao lookup e ao reset**

```js
const shippingContext = rules.listingShippingContext(row);
syncShippingMode(shippingContext.simulationMode);
setText("calc-listing-shipping-mode", [shippingContext.modeLabel, shippingContext.logisticLabel].filter(Boolean).join(" · "));
setText("calc-listing-shipping-payment", shippingContext.paymentLabel);
setText("calc-listing-shipping-quote", shippingContext.quoteStatus === "estimated"
  ? `Custo estimado do vendedor pelo ML: ${fmtMoney(row.seller_shipping)}. Pode variar após a venda.`
  : shippingContext.quoteStatus === "unavailable"
    ? "Estimativa do ML indisponível. Informe o custo do vendedor para simular."
    : "Valor pago pelo comprador é opcional e depende do destino.");
$("calc-listing-shipping-context").hidden = false;
```

Usar `textContent` via `setText`; ocultar o contexto em manual/reset e mostrá-lo a cada novo lookup de anúncio. Os botões passam a dizer “Custo do vendedor” e “Pago pelo comprador” apenas quando um anúncio está carregado; a simulação manual mantém os rótulos anteriores. O valor oculto continua zerado e desabilitado pela lógica existente.

- [ ] **Step 5: Estilizar e verificar**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js; node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: PASS. O bloco respeita `[hidden]` e os tokens dos temas claro/escuro.

### Task 3: Regressão

- [ ] **Step 1: Rodar a suíte da Calculadora**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS sem falhas.

- [ ] **Step 2: Conferir diff e sintaxe**

Run: `git diff --check; node --check apps/seller-ml/public/js/financeiro-ml-calculator-rules.js; node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js`

Expected: exit code 0.

- [ ] **Step 3: Integrar localmente**

Commitar apenas os arquivos desta tarefa na branch isolada, incorporar na `main` por fast-forward e repetir a suíte após o merge. Push/deploy não fazem parte deste pedido.
