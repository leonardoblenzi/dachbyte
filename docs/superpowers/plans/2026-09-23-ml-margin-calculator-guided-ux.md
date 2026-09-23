# Calculadora de Margem ML — UX Guiada Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernizar a calculadora de margem do Seller ML com controles explícitos de comissão e frete, preservando a busca de anúncios e os contratos de cálculo existentes.

**Architecture:** A página passa a expressar as escolhas de simulação em controles HTML semânticos, enquanto o JavaScript normaliza a modalidade de frete para os campos que o endpoint já entende. O serviço e `pricingEngine` continuam sendo a fonte de verdade: `seller_shipping` é custo e `buyer_shipping_taxable` apenas amplia a base tributável.

**Tech Stack:** HTML, CSS, JavaScript vanilla, Node.js `node:test`, serviços CommonJS.

---

### Task 1: Cobrir o contrato da modalidade de frete

**Files:**
- Modify: `apps/seller-ml/tests/pricing-engine.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("frete opcional do comprador so amplia a base fiscal", () => {
  const result = calculatePricingSnapshot({
    price: 100, productCost: 40, taxRate: 0.1,
    sellerShipping: 0, buyerShippingTaxable: 12,
  });
  assert.equal(result.seller_shipping, 0);
  assert.equal(result.buyer_shipping_taxable, 12);
  assert.equal(result.total_costs, 51.2);
  assert.equal(result.taxes, 11.2);
});
```

- [ ] **Step 2: Run the focused test to verify its current behaviour**

Run: `node --test apps/seller-ml/tests/pricing-engine.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`

Expected: the new test confirms current engine behaviour or identifies a contract discrepancy before UI code is changed.

- [ ] **Step 3: Keep the existing engine contract and add only client-side normalization**

```js
seller_shipping: shippingMode === "mercado_envios" ? inputValue("calc-seller-shipping") : 0,
buyer_shipping_taxable: shippingMode === "comprador" ? inputValue("calc-buyer-shipping") : 0,
```

The pricing engine already meets the contract; do not add a second calculation path in the service.

- [ ] **Step 4: Re-run the focused service test**

Run: `node --test apps/seller-ml/tests/pricing-engine.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`

Expected: PASS, with buyer freight present in `inputs` and excluded from `total_costs`.

### Task 2: Add regression coverage for the guided UI

**Files:**
- Create: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`

- [ ] **Step 1: Write failing source-level UI contract tests**

```js
test("exibe busca de anuncio, controles segmentados e campos de frete condicionais", () => {
  assert.match(html, /id="calc-lookup-input"/);
  assert.match(html, /data-listing-type="gold_special"/);
  assert.match(html, /data-shipping-mode="mercado_envios"/);
  assert.match(html, /id="calc-buyer-shipping-wrap"/);
  assert.doesNotMatch(html, /<span class="calc-eyebrow">Resultado<\/span><h2>Resultado da simulação<\/h2>/);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: FAIL because the current select/always-visible freight inputs do not implement this contract.

- [ ] **Step 3: Implement semantic controls and state synchronization**

Add button groups with `aria-pressed` for listing type and shipping mode. Add `syncListingTypeControl`, `syncShippingMode`, and `setLoadedListingState` in `financeiro-ml-calculadora.js`; `buildPayload` must send zero for hidden freight mode and retain optional buyer freight only in buyer mode.

- [ ] **Step 4: Re-run the UI test**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: PASS.

### Task 3: Redesign the page surface with DACH ML tokens

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`

- [ ] **Step 1: Write visual source assertions**

Extend `financeiro-ml-calculadora-ui.test.js` to assert the existing DACH values `#ff9a4d`, `#0f766e`, or their `--calc-*` token equivalents remain present and that the result header is `Lucro por unidade`.

- [ ] **Step 2: Run the test and verify red**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: FAIL until the header and new controls exist.

- [ ] **Step 3: Apply the visual hierarchy**

Keep the two-column desktop layout and sticky result card. Style the new segments and conditional freight panel with existing `--calc-accent`, `--calc-action`, and neutral tokens. Reduce normal field label/value weights; do not weaken error, action, or result emphasis. Move taxes and operation into a visible subcard after freight.

- [ ] **Step 4: Verify the focused UI test**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: PASS.

### Task 4: Verify integration and prepare the branch

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Create: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

- [ ] **Step 1: Check syntax and focused suite**

Run:

```bash
node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js
node --test apps/seller-ml/tests/pricing-engine.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Review changed files**

Run: `git diff -- apps/seller-ml/views/financeiro-ml-calculadora.html apps/seller-ml/public/js/financeiro-ml-calculadora.js apps/seller-ml/public/css/financeiro-ml-calculadora.css apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`

Expected: no endpoint or pricing-engine behaviour is changed beyond payload normalization needed for conditional UI.

- [ ] **Step 3: Commit only the calculator files**

```bash
git add apps/seller-ml/views/financeiro-ml-calculadora.html apps/seller-ml/public/js/financeiro-ml-calculadora.js apps/seller-ml/public/css/financeiro-ml-calculadora.css apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js docs/superpowers/specs/2026-09-23-ml-margin-calculator-guided-ux-design.md docs/superpowers/plans/2026-09-23-ml-margin-calculator-guided-ux.md
git commit -m "Modernize ML margin calculator flow"
```
