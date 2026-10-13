# Calculator ME2 Split Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Descontar a parcela de envio paga pelo vendedor em anúncios ME2 mesmo quando o comprador também paga frete, sem apresentar um lucro completo quando a cotação está ausente ou desatualizada.

**Architecture:** O serviço de lookup consulta `/users/{seller_id}/shipping_options/free` com `free_shipping=false` para ME2 e devolve custo e origem da cotação, preservando indisponibilidade como estado distinto de zero. Uma regra pura identifica frete dividido e valida a cotação em relação ao preço atual. A interface exibe os dois campos simultâneos só nesse cenário, preserva ambos no payload e suspende números derivados enquanto o custo do vendedor não estiver confirmado.

**Tech Stack:** Node.js, JavaScript no navegador, HTML/CSS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-06-calculator-me2-split-shipping-design.md`

---

### Task 1: Cotar a parcela do vendedor no ME2 pago pelo comprador

**Files:**
- Modify: `apps/seller-ml/services/financeiroMlCalculatorService.js`
- Create: `apps/seller-ml/tests/financeiro-ml-calculator-split-shipping-service.test.js`

- [ ] **Step 1: Escrever o teste RED da cotação ME2.** Seguir o cabeçalho de mock de `node-fetch` usado em `financeiro-ml-calculator-hardening.test.js`, importar `Calculator` e adicionar:

```js
test("ME2 buyer-paid quotes the seller share with free_shipping=false", async () => {
  const urls = [];
  Calculator._test.setShippingQuoteRequest(async (_state, url) => {
    urls.push(new URL(url));
    return { coverage: { all_country: { list_cost: 8.4 } } };
  });
  try {
    const quote = await Calculator._test.fetchSellerShipping(
      { token: "test" },
      { id: "MLB6311005168", price: 35.9, listing_type_id: "gold_special",
        shipping: { mode: "me2", logistic_type: "xd_drop_off", free_shipping: false } },
      "123", 35.9,
    );
    assert.equal(quote.seller_cost, 8.4);
    assert.equal(urls[0].searchParams.get("free_shipping"), "false");
    assert.equal(urls[0].searchParams.get("item_id"), "MLB6311005168");
    assert.equal(urls[0].searchParams.get("logistic_type"), "xd_drop_off");
  } finally {
    Calculator._test.resetShippingQuoteRequest();
  }
});
```

- [ ] **Step 2: Rodar RED.** `node --test apps/seller-ml/tests/financeiro-ml-calculator-split-shipping-service.test.js` deve falhar porque o serviço ainda retorna zero sem consultar a API.

- [ ] **Step 3: Implementar a cotação mínima.** Substituir o retorno antecipado em `fetchSellerShipping` por retorno `buyer_paid` apenas fora de ME2 quando não há frete grátis. Para ME2, montar o endpoint de usuário já existente com `free_shipping=String(Boolean(item.shipping.free_shipping))`; consultar com `shippingQuoteRequest(state, url)` e aceitar `coverage.all_country.list_cost` apenas quando a propriedade existe e é número não negativo. Não usar `base_cost` nem custo do comprador como parcela do vendedor. Se ME2 pago pelo comprador falhar, retornar `{ seller_cost: 0, source: "unavailable" }`, nunca `buyer_paid`. Conservar o fallback anterior de ME2 grátis, sem alterar modalidades não ME2.

```js
let shippingQuoteRequest = mlJson;
const isMe2 = text(item?.shipping?.mode) === "me2";
if (!item?.shipping?.free_shipping && !isMe2) return { seller_cost: 0, source: "buyer_paid" };
url.searchParams.set("free_shipping", String(Boolean(item?.shipping?.free_shipping)));
const payload = await shippingQuoteRequest(state, url.toString()).catch(() => null);
const quoted = payload?.coverage?.all_country?.list_cost;
if (quoted != null && Number.isFinite(Number(quoted)) && Number(quoted) >= 0) {
  return { seller_cost: Number(quoted), source: "users_shipping_options_free" };
}
```

Adicionar `fetchSellerShipping`, `setShippingQuoteRequest` e `resetShippingQuoteRequest` a `_test`, seguindo o padrão de `listingPriceRequest`.

- [ ] **Step 4: Cobrir zero explícito e falha de cotação; rodar GREEN.** No mesmo arquivo de teste, usar `setShippingQuoteRequest` para devolver `{ coverage: { all_country: { list_cost: 0 } } }` e exigir `{ seller_cost: 0, source: "users_shipping_options_free" }`; repetir com `{ coverage: {} }` e com `throw new Error("unavailable")`, exigindo `{ seller_cost: 0, source: "unavailable" }`. O método deve evitar o fallback `/items/{id}/shipping_options/free` quando `free_shipping=false`, pois ele cotaria a modalidade errada. Rodar o teste novo e `node --test apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`.
- [ ] **Step 5: Commit local.** `git add apps/seller-ml/services/financeiroMlCalculatorService.js apps/seller-ml/tests/financeiro-ml-calculator-split-shipping-service.test.js` e `git commit -m "Quote seller share for buyer-paid ME2 shipping"`.

### Task 2: Exibir e enviar as duas parcelas sem exclusividade

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`

- [ ] **Step 1: Escrever RED nas regras.** Acrescentar em `financeiro-ml-calculator-ux.test.js`, preservando o teste existente de exclusividade manual:

```js
test("buyer-paid ME2 keeps both shipping shares", () => {
  const context = rules.listingShippingContext({
    shipping_mode: "me2", free_shipping: false,
    shipping_source: "users_shipping_options_free", seller_shipping: 8.4,
  });
  assert.equal(context.split, true);
  assert.equal(context.quoteStatus, "estimated");
  assert.deepEqual(rules.shippingVisibility("comprador", { split: true }), { seller: true, buyer: true });
  assert.deepEqual(rules.normalizeShippingInputs("comprador", {
    sellerShipping: 8.4, buyerShipping: 5,
  }, { split: true }), { sellerShipping: 8.4, buyerShipping: 5 });
});
```
- [ ] **Step 2: Rodar RED.** `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js` deve falhar nas novas asserções.
- [ ] **Step 3: Implementar regras puras.** Em `listingShippingContext`, definir `split = mode === "me2" && item.free_shipping === false`; `quoteStatus` para esse caso depende de `shipping_source`, mesmo quando `simulationMode` é `comprador`. Acrescentar parâmetro opcional `{ split=false }` às duas funções existentes:

```js
if (split) return { seller: true, buyer: true }; // shippingVisibility
if (split) return { sellerShipping: Number(sellerShipping) || 0, buyerShipping: Number(buyerShipping) || 0 }; // normalizeShippingInputs
```

- [ ] **Step 4: Testar RED de interface e payload.** Em `financeiro-ml-calculadora-ui.test.js` exigir `id="calc-split-shipping-alert"`, `role="alert"`, o texto “Estimativa do ML” e CSS `.calc-segmented-control[hidden]`. Em `financeiro-ml-calculator-ui-payload.test.js`, exigir `split: isSplitShipping()` na chamada a `normalizeShippingInputs`, `seller_shipping: shipping.sellerShipping` e `buyer_shipping_taxable: shipping.buyerShipping`. Rodar ambos os testes para ver falha dos novos contratos.
- [ ] **Step 5: Implementar a interface.** Adicionar o alerta abaixo do contexto no bloco Frete e CSS de ocultação:

```html
<p id="calc-split-shipping-alert" class="calc-data-alert" role="alert" data-tone="warning" hidden></p>
```

```css
.calc-segmented-control[hidden] { display: none !important; }
```

No JS, usar `function isSplitShipping() { return state.mode === "listing" && state.selected?.shipping_mode === "me2" && state.selected?.free_shipping === false; }`. Em anúncio dividido, ocultar `calc-shipping-controls`, mostrar os dois campos e manter `calc-seller-shipping` com `row.seller_shipping` somente quando `shipping_source` indica cotação; caso contrário, `setInput("calc-seller-shipping", "")`. Para outros modos, manter a seleção exclusiva. Em `buildPayload`, passar `{ split: isSplitShipping() }` a `normalizeShippingInputs`. Ajustar `calc-listing-shipping-quote`, `calc-item-source` e `calc-breakdown-shipping-source` para não apresentar zero sem cotação como confirmado. Incrementar o cache-bust dos assets alterados no HTML.
- [ ] **Step 6: Rodar GREEN e regressão.** `node --check` nos dois JS do navegador; `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`.
- [ ] **Step 7: Commit local.** `git add` somente os sete arquivos desta tarefa e `git commit -m "Show both ME2 shipping shares in calculator"`.

### Task 3: Não mostrar lucro completo com frete desconhecido ou defasado

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`

- [ ] **Step 1: Escrever RED de validade da cotação.** Adicionar em `financeiro-ml-calculator-ux.test.js`:

```js
test("split-shipping result waits for a known seller share at this price", () => {
  const base = { split: true, source: "users_shipping_options_free",
    loadedPrice: 35.9, currentPrice: 35.9, quotedValue: 8.4,
    sellerValue: "8.4", manuallyConfirmedPrice: null };
  assert.deepEqual(rules.splitShippingReadiness(base), { ready: true, reason: "" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, source: "unavailable", sellerValue: "" }),
    { ready: false, reason: "missing" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, currentPrice: 40 }),
    { ready: false, reason: "stale" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, source: "unavailable", sellerValue: "0", manuallyConfirmedPrice: 35.9 }),
    { ready: true, reason: "" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, split: false }), { ready: true, reason: "" });
});
```
- [ ] **Step 2: Rodar RED.** `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js` deve falhar porque `splitShippingReadiness` ainda não existe.
- [ ] **Step 3: Implementar e integrar.** Exportar a função pura com esta regra: se `split` for falso, retornar `{ready:true,reason:""}`; se `sellerValue` for vazio, inválido ou negativo, `missing`; aceitar cotação somente com origem `users_shipping_options_free`/`items_shipping_options_free`, preço igual a `loadedPrice` e valor igual a `quotedValue`; aceitar valor manual somente com `manuallyConfirmedPrice === currentPrice`; caso contrário, `stale` se havia cotação e `missing` se não havia.

No navegador, adicionar `state.manualShippingPrice = null`; preencher com o preço atual no evento `input` de `calc-seller-shipping`; zerar em `applyLoadedItem`, `resetForm` e troca de modo. Avaliar a prontidão usando o valor bruto `$("calc-seller-shipping").value` (não `inputValue`, que converte campo vazio em zero). Se não estiver pronta, cancelar cálculo pendente, ocultar callout, trocar lucro/margem/ROI/preço mínimo/preço-alvo para `--`, marcar badge `Frete pendente`, preencher `calc-split-shipping-alert` e `calc-result-note`, e não enviar `/calculate`. Adicionar botão `id="calc-confirm-shipping"` com texto “Usar este custo neste preço” somente para cotação defasada; clicar grava `state.manualShippingPrice` para o preço atual. Digitar custo também confirma esse preço. Retornar ao preço originalmente cotado restaura a cotação apenas se o campo ainda igualar `quotedValue`.

- [ ] **Step 4: Rodar GREEN e testes financeiros.** `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/pricing-engine.test.js`. Acrescentar em `pricing-engine.test.js` uma asserção que compara dois snapshots com preço/comissão/imposto idênticos, mas `sellerShipping` 0 versus 8.4; o lucro deve diferir em R$ 8,40 e `buyerShippingTaxable` deve permanecer separado.
- [ ] **Step 5: Commit local.** `git add` apenas os arquivos desta tarefa e `git commit -m "Guard calculator results when split shipping quote is incomplete"`.

### Task 4: Verificação integrada e entrega

**Files:** nenhum arquivo de produção adicional.

- [ ] **Step 1: Executar verificação completa.** `node --check` para serviço e JS alterados; `node --test` para todos os testes da calculadora; `git diff --check`; confirmar zero falhas e nenhum diff não intencional.
- [ ] **Step 2: Conferir visualmente em claro e escuro.** Usar navegador de teste com conta autorizada, ou declarar explicitamente que o QA visual autenticado não foi possível. Verificar ME2 dividido cotado, indisponível, preço editado, ME2 grátis, ME1 e modo manual.
- [ ] **Step 3: Integrar por fast-forward à `main` local somente se o checkout estiver seguro.** Preservar arquivos não rastreados e mudanças alheias. Não fazer push/deploy sem pedido específico.
