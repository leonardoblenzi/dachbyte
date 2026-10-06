# Calculadora ML: confiança dos dados Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir a exclusividade do frete e tornar visível a confiabilidade, a origem e as limitações dos valores usados na Calculadora ML.

**Architecture:** O navegador passa a normalizar o formulário de frete antes de montar o payload e deriva um estado de confiança do custo, da comissão e do frete. O serviço de lookup acrescenta o nome de categoria do anúncio para a interface não expor somente um ID. HTML e CSS recebem alertas e etiquetas sem alterar as fórmulas financeiras ou permitir escrita no Mercado Livre.

**Tech Stack:** Express/CommonJS, JavaScript no navegador, CSS, HTML, `node:test`.

---

## Estrutura de arquivos

- `apps/seller-ml/services/financeiroMlCalculatorService.js`: busca e fornece nome legível da categoria junto ao anúncio carregado.
- `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`: regras puras de normalização do frete e de confiança do custo.
- `apps/seller-ml/public/js/financeiro-ml-calculadora.js`: sincroniza controles, payload, origem e resultado.
- `apps/seller-ml/views/financeiro-ml-calculadora.html`: inclui aviso de custo, contexto do anúncio e etiquetas do detalhamento.
- `apps/seller-ml/public/css/financeiro-ml-calculadora.css`: força ocultação de campos inativos e aplica a hierarquia visual.
- `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`, `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`, `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js` e `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`: testes das regras, contrato de DOM, payload e categoria.

### Task 1: Normalizar frete exclusivo e confiança do custo

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.deepEqual(rules.normalizeShippingInputs("mercado_envios", { sellerShipping: 18, buyerShipping: 42 }), {
  sellerShipping: 18, buyerShipping: 0,
});
assert.deepEqual(rules.normalizeShippingInputs("comprador", { sellerShipping: 18, buyerShipping: 42 }), {
  sellerShipping: 0, buyerShipping: 42,
});
assert.deepEqual(rules.costConfidence(0), { state: "missing", roiAvailable: false });
assert.deepEqual(rules.costConfidence(27.5), { state: "ready", roiAvailable: true });
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque os helpers ainda não existem.

- [ ] **Step 3: Implementar helpers puros**

```js
function normalizeShippingInputs(mode, { sellerShipping = 0, buyerShipping = 0 } = {}) {
  return mode === "comprador"
    ? { sellerShipping: 0, buyerShipping: Number(buyerShipping) || 0 }
    : { sellerShipping: Number(sellerShipping) || 0, buyerShipping: 0 };
}
function costConfidence(productCost) {
  return Number(productCost) > 0
    ? { state: "ready", roiAvailable: true }
    : { state: "missing", roiAvailable: false };
}
```

Exportar ambos no objeto `api`, sem modificar fórmulas de margem, lucro ou ROI.

- [ ] **Step 4: Rodar GREEN**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculator-rules.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar**

```bash
git add apps/seller-ml/public/js/financeiro-ml-calculator-rules.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js
git commit -m "Add calculator input confidence rules"
```

### Task 2: Enriquecer o anúncio com a categoria legível

**Files:**
- Modify: `apps/seller-ml/services/financeiroMlCalculatorService.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.equal(Calculator._test.categoryLabel({ name: "Sofás" }, "MLB1626"), "Sofás");
assert.equal(Calculator._test.categoryLabel(null, "MLB1626"), "MLB1626");
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`

Expected: FAIL porque o helper não existe.

- [ ] **Step 3: Implementar consulta e fallback de categoria**

```js
function categoryLabel(category = {}, fallbackId = "") {
  return text(category?.name || category?.path_from_root?.at(-1)?.name || fallbackId);
}
async function fetchCategory(state, categoryId) {
  const id = text(categoryId);
  if (!id) return { id: "", name: "" };
  const payload = await mlJson(state, `/categories/${encodeURIComponent(id)}`).catch(() => null);
  return { id, name: categoryLabel(payload, id) };
}
```

Em `pricingForCandidate()`, buscar a categoria em paralelo com custo, imposto, tarifa e frete; retornar `category_name`. Incluir `category_name` no objeto `selected` do lookup. A falha dessa consulta não pode interromper o lookup: deve usar o ID como fallback.

- [ ] **Step 4: Rodar GREEN**

Run: `node --check apps/seller-ml/services/financeiroMlCalculatorService.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar**

```bash
git add apps/seller-ml/services/financeiroMlCalculatorService.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js
git commit -m "Expose readable calculator category"
```

### Task 3: Atualizar DOM e estilos de confiança

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

- [ ] **Step 1: Escrever testes RED de contrato visual**

```js
assert.match(html, /id="calc-cost-confidence"/);
assert.match(html, /id="calc-loaded-category"/);
assert.match(html, /id="calc-breakdown-cost-source"/);
assert.match(html, /id="calc-breakdown-commission-source"/);
assert.match(html, /id="calc-breakdown-shipping-source"/);
assert.match(css, /\.calc-shipping-field\[hidden\]\s*\{\s*display:\s*none\s*!important/);
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: FAIL porque os elementos e a regra CSS ainda não existem.

- [ ] **Step 3: Adicionar estrutura semântica**

```html
<p id="calc-cost-confidence" class="calc-data-alert" data-tone="warning" hidden>
  <strong>Custo do produto não informado.</strong>
  Lucro e margem podem estar superestimados.
</p>
<small id="calc-loaded-category">Categoria: —</small>
<span id="calc-breakdown-cost-source" class="calc-source-tag"></span>
<span id="calc-breakdown-commission-source" class="calc-source-tag"></span>
<span id="calc-breakdown-shipping-source" class="calc-source-tag"></span>
```

Colocar o alerta logo abaixo da grade de preço/custo, `calc-loaded-category` no cartão do anúncio e cada etiqueta na respectiva linha do detalhamento. Incluir texto de bloqueio de dados no cartão carregado: “Tipo, categoria e comissão vêm do anúncio”.

- [ ] **Step 4: Implementar estilo que respeita `hidden`**

```css
.calc-shipping-field[hidden] { display: none !important; }
.calc-data-alert { margin: 12px 0 0; padding: 10px 12px; border-radius: 12px; }
.calc-data-alert[data-tone="warning"] { color: var(--fml-warning-text); background: var(--fml-warning-bg); }
.calc-source-tag { margin-left: 6px; color: var(--calc-muted); font-size: .69rem; font-weight: 700; }
```

No tema escuro, manter contraste dos alertas e das etiquetas usando os tokens já usados pela Calculadora. Reduzir apenas bordas redundantes das sub-seções; não alterar a grade responsiva.

- [ ] **Step 5: Rodar GREEN**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: PASS.

- [ ] **Step 6: Commitar**

```bash
git add apps/seller-ml/views/financeiro-ml-calculadora.html apps/seller-ml/public/css/financeiro-ml-calculadora.css apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js
git commit -m "Add calculator data confidence UI"
```

### Task 4: Conectar formulário, resultado e fontes

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED do contrato de formulário**

```js
assert.match(source, /normalizeShippingInputs/);
assert.match(source, /\.disabled\s*=\s*!visible\.seller/);
assert.match(source, /setText\("calc-loaded-category"/);
assert.match(source, /setText\("calc-breakdown-cost-source"/);
assert.match(source, /Sem tarifa fixa aplicável/);
assert.match(source, /calc-cost-confidence/);
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque o script não normaliza os controles nem atualiza os novos elementos.

- [ ] **Step 3: Implementar sincronização de frete**

```js
function syncShippingMode(mode = state.shippingMode) {
  state.shippingMode = mode === "comprador" ? "comprador" : "mercado_envios";
  const visible = rules.shippingVisibility(state.shippingMode);
  const normalized = rules.normalizeShippingInputs(state.shippingMode, {
    sellerShipping: inputValue("calc-seller-shipping"),
    buyerShipping: inputValue("calc-buyer-shipping"),
  });
  setInput("calc-seller-shipping", normalized.sellerShipping);
  setInput("calc-buyer-shipping", normalized.buyerShipping);
  $("calc-seller-shipping-wrap").hidden = !visible.seller;
  $("calc-buyer-shipping-wrap").hidden = !visible.buyer;
  $("calc-seller-shipping").disabled = !visible.seller;
  $("calc-buyer-shipping").disabled = !visible.buyer;
}
```

Em `buildPayload()`, aplicar novamente `normalizeShippingInputs` e usar somente seus valores. Isso garante que campos invisíveis não entrem no POST, mesmo quando o evento da interface for perdido.

- [ ] **Step 4: Implementar confiança e origem**

```js
function syncCostConfidence({ productCost = inputValue("calc-product-cost"), roiPct = null } = {}) {
  const confidence = rules.costConfidence(productCost);
  $("calc-cost-confidence").hidden = confidence.state !== "missing";
  setText("calc-result-roi", confidence.roiAvailable ? fmtPct(roiPct) : "--");
}
function sourceLabel({ source, value }) {
  if (!(Number(value) > 0)) return "Não informado";
  return source === "mercado_livre" ? "Mercado Livre" : source === "estimativa" ? "Estimativa" : "Informado manualmente";
}
```

Implementar a função sem depender de variável global `result`: `syncCostConfidence` deve receber também `roiPct` ao renderizar resultado. Atualizar categoria carregada com `row.category_name || row.category_id`; a origem de comissão vem de `payload.fee_mode`, a de frete vem de anúncio carregado ou entrada manual e a de custo é “Não informado” quando zero. Para `commission_fixed === 0`, renderizar “Sem tarifa fixa aplicável” no detalhamento. Quando houver meta, o callout deve começar por “Preço atual”, “Preço para a meta” e “Diferença”.

- [ ] **Step 5: Rodar GREEN**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: PASS.

- [ ] **Step 6: Commitar**

```bash
git add apps/seller-ml/public/js/financeiro-ml-calculadora.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js
git commit -m "Clarify calculator freight and data sources"
```

### Task 5: Validar regressões da Calculadora

**Files:**
- Test: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`
- Test: `apps/seller-ml/tests/pricing-engine.test.js`

- [ ] **Step 1: Verificar sintaxe e diff**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculator-rules.js; node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js; git diff --check`

Expected: exit code 0.

- [ ] **Step 2: Rodar a suíte de regressão**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS sem falhas.

- [ ] **Step 3: Verificação manual**

```text
1. Em Mercado Envios, somente a tarifa do vendedor aparece; em Pago pelo comprador, somente o valor do comprador aparece.
2. Troque as modalidades após preencher valor e confirme que o detalhamento usa apenas a modalidade ativa.
3. Deixe custo em R$ 0,00 e confirme alerta amarelo e ROI “--”; informe custo e confirme remoção do alerta.
4. Carregue um MLB e confirme nome da categoria, dados bloqueados e origem Mercado Livre.
5. Confirme que tarifa fixa zero mostra “Sem tarifa fixa aplicável”.
6. Preencha margem desejada e confira preço atual, preço da meta e diferença no callout.
```

- [ ] **Step 4: Commitar a validação**

```bash
git status -sb
git commit --allow-empty -m "Verify calculator data confidence flow"
```

