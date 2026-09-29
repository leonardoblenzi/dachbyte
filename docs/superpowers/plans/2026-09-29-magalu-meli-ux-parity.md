# Magalu Meli UX Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Seller Magalu use the same navigational, dashboard, operation and pricing interaction model that Seller Mercado Livre uses, while retaining Magalu-only data contracts and safe-write rules.

**Architecture:** Keep the existing canonical Magalu shell (`views/app.html`) and its isolated JS/CSS. Extend the existing dashboard, financial and protected-write APIs rather than coupling to any Mercado Livre service. Add small Magalu-specific UI controllers for reusable operation selection and dashboard priority derivation; all remote writes remain in the existing preview/apply workers.

**Tech Stack:** Node.js 20, Express, PostgreSQL, BullMQ, vanilla browser JavaScript, CSS custom properties, `node:test`.

---

## File structure

- Modify `apps/seller-magalu/views/app.html`: canonical navigation, page markup and loading order.
- Modify `apps/seller-magalu/public/css/magalu-app.css`: shared dashboard, wizard, financial and responsive visual primitives.
- Create `apps/seller-magalu/public/js/magalu-operation-flow.js`: reusable UI-only selection/action/review state for catalog, price and stock.
- Modify `apps/seller-magalu/public/js/magalu-app.js`: route map, dashboard rendering and integration of the shared operation UI.
- Modify `apps/seller-magalu/public/js/magalu-sku-management.js`: consume the shared flow without altering guarded SKU batch calls.
- Modify `apps/seller-magalu/public/js/magalu-financial.js`: filters, coverage and guided calculator rendering.
- Modify `apps/seller-magalu/src/controllers/dashboardController.js` and `apps/seller-magalu/src/repositories/{catalogRepository,financialRepository,orderRepository}.js`: return only local, auditable aggregates required by the panel.
- Create focused contract tests under `apps/seller-magalu/tests/`; preserve current protected-write test coverage.

## Task 1: Lock down the canonical navigation and page contract

**Files:**
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Test: `apps/seller-magalu/tests/meli-ux-shell-contract.test.js`

- [ ] **Step 1: Write the failing navigation contract**

```js
test("Magalu navigation uses the Meli-equivalent vocabulary and every declared route has a page", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  assert.match(html, /<strong>Precificação<\/strong>/);
  for (const path of ["/", "/gestao-skus", "/pedidos", "/precos", "/estoque", "/custos", "/margem", "/calculadora", "/contas", "/integracoes"]) {
    assert.match(client, new RegExp(`"${path}"`));
    assert.match(html, new RegExp(`data-page="${path.replace("/", "\\/")}"`));
  }
  for (const orphan of ["/usuarios", "/plano", "/ajuda"]) assert.doesNotMatch(client, new RegExp(`"${orphan}"`));
});
```

- [ ] **Step 2: Run the test and confirm it fails for the current `Financeiro` label and orphan routes**

Run: `npm test -- tests/meli-ux-shell-contract.test.js`

Expected: FAIL because the existing shell says `Financeiro` and `magalu-app.js` declares routes without matching pages.

- [ ] **Step 3: Make the smallest contract change**

In `app.html`, replace the Financial group label with `Precificação` and retain the three current links. In `magalu-app.js`, remove `/usuarios`, `/plano`, and `/ajuda` from `routes` until corresponding shell pages are implemented. Do not remove server endpoints or account management data.

- [ ] **Step 4: Run the test and the shell regression suite**

Run: `npm test -- tests/meli-ux-shell-contract.test.js tests/ui-shell-consistency.test.js tests/financial-pricing-ui.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the isolated navigation change**

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/tests/meli-ux-shell-contract.test.js
git commit -m "Align Magalu navigation with Meli UX"
```

## Task 2: Add the Magalu dashboard read model needed for comparable decisions

**Files:**
- Modify: `apps/seller-magalu/src/repositories/orderRepository.js`
- Modify: `apps/seller-magalu/src/repositories/catalogRepository.js`
- Modify: `apps/seller-magalu/src/repositories/financialRepository.js`
- Modify: `apps/seller-magalu/src/controllers/dashboardController.js`
- Test: `apps/seller-magalu/tests/dashboard-meli-parity.test.js`

- [ ] **Step 1: Write failing controller/repository contract tests**

```js
test("dashboard returns a selected-period comparison, data coverage and actionable local risks", () => {
  const controller = read("src/controllers/dashboardController.js");
  assert.match(controller, /period/);
  assert.match(controller, /comparison/);
  assert.match(controller, /priorities/);
  assert.match(controller, /margin_coverage/);
  assert.doesNotMatch(controller, /roas|ads_cost|ads_revenue/i);
});

test("dashboard accepts only preset local periods", () => {
  const controller = read("src/controllers/dashboardController.js");
  assert.match(controller, /\["today", "7d", "14d", "30d"\]/);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/dashboard-meli-parity.test.js`

Expected: FAIL because the current `/dashboard` response is fixed to a 30-day window and has no decision-priority model.

- [ ] **Step 3: Implement period-safe local aggregates**

Add repository methods that take an `accountId` and a validated `days`/date range and return: orders, gross value, average ticket, prior-period counterparts, published SKU count, zero-stock count, and count/coverage of products with stored cost. Keep the aggregate SQL account-scoped; never expose order buyer data, tokens or raw OAuth metadata.

In `dashboardController.status`, map only `today`, `7d`, `14d`, and `30d` to ranges. Return:

```js
{
  period: { key: "7d", label: "Últimos 7 dias" },
  comparison: { orders_delta, gross_value_delta },
  commerce: { orders, gross_value, ticket_average },
  catalog: { published_count, zero_stock_count },
  margin: { value: null, coverage: { priced_skus: 0, costed_skus: 0, percent: 0 } },
  priorities: [{ tone: "warning", title: "Estoque zerado", count: 3, href: "/magalu/estoque" }],
  ads: { status: "pending" }
}
```

Return `margin.value: null` when inputs are insufficient. Priorities must be derived from the returned local counts only, with a valid Magalu route for every `href`.

- [ ] **Step 4: Re-run contract and existing dashboard tests**

Run: `npm test -- tests/dashboard-meli-parity.test.js tests/dashboard-commercial.test.js tests/financial-pricing.test.js`

Expected: PASS.

- [ ] **Step 5: Commit dashboard read model**

```bash
git add apps/seller-magalu/src/repositories/orderRepository.js apps/seller-magalu/src/repositories/catalogRepository.js apps/seller-magalu/src/repositories/financialRepository.js apps/seller-magalu/src/controllers/dashboardController.js apps/seller-magalu/tests/dashboard-meli-parity.test.js
git commit -m "Add Magalu dashboard decision metrics"
```

## Task 3: Rebuild the dashboard presentation in the Meli information hierarchy

**Files:**
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Modify: `apps/seller-magalu/public/css/magalu-app.css`
- Test: `apps/seller-magalu/tests/dashboard-meli-parity.test.js`

- [ ] **Step 1: Add failing UI assertions**

```js
test("dashboard exposes Meli-style period, priorities and commercial sections without invented Ads metrics", () => {
  const html = read("views/app.html");
  assert.match(html, /id="mg-dashboard-period"/);
  assert.match(html, /id="mg-dashboard-priorities"/);
  assert.match(html, /Comercial e resultado/);
  assert.match(html, /Sinais operacionais/);
  assert.match(html, /Integração de Ads pendente/);
  assert.doesNotMatch(html, /ROAS médio|Investimento Ads|Receita Ads/);
});
```

- [ ] **Step 2: Confirm the assertion fails**

Run: `npm test -- tests/dashboard-meli-parity.test.js`

Expected: FAIL because the current dashboard is a technical status grid.

- [ ] **Step 3: Implement the page and renderer**

Replace the current dashboard-only markup with:

```html
<div class="mg-dashboard-actions">
  <div id="mg-dashboard-period" role="group" aria-label="Período do painel">
    <button data-period="today" type="button">Hoje</button>
    <button data-period="7d" type="button">7 dias</button>
    <button data-period="14d" type="button">14 dias</button>
    <button data-period="30d" type="button">30 dias</button>
  </div>
  <button id="mg-dashboard-refresh" class="mg-icon-btn" type="button" aria-label="Atualizar painel">↻</button>
</div>
<section id="mg-dashboard-priorities" class="mg-dashboard-priorities" aria-live="polite"></section>
```

Render periods through `/magalu/api/dashboard?account_id=<id>&period=<key>`. Preserve the global loading overlay. Render local priorities as links, render margin coverage honestly, and keep the Ads card as a disabled pending-integration card.

Move account OAuth/token/webhook details out of the dashboard; retain them in `/magalu/integracoes`.

- [ ] **Step 4: Verify UI contracts and syntax**

Run: `node --check public/js/magalu-app.js; npm test -- tests/dashboard-meli-parity.test.js tests/dashboard-commercial.test.js tests/magalu-loading-overlay.test.js`

Expected: exit code 0.

- [ ] **Step 5: Commit dashboard presentation**

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/public/css/magalu-app.css apps/seller-magalu/tests/dashboard-meli-parity.test.js
git commit -m "Restructure Magalu dashboard around seller decisions"
```

## Task 4: Extract the reusable operation-selection UI

**Files:**
- Create: `apps/seller-magalu/public/js/magalu-operation-flow.js`
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/css/magalu-app.css`
- Test: `apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

- [ ] **Step 1: Write a failing client contract**

```js
test("all writable Magalu resources expose filter, single-SKU and pasted-list selection steps", () => {
  const html = read("views/app.html");
  const flow = read("public/js/magalu-operation-flow.js");
  for (const resource of ["catalog", "price", "stock"]) {
    assert.match(html, new RegExp(`data-operation-resource="${resource}"`));
    assert.match(html, new RegExp(`data-operation-mode="single"`));
    assert.match(html, new RegExp(`data-operation-mode="list"`));
  }
  assert.match(flow, /normalizeExplicitSkus/);
  assert.match(flow, /Seleção/);
  assert.match(flow, /Ação/);
  assert.match(flow, /Revisão/);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npm test -- tests/magalu-operation-flow-ui.test.js`

Expected: FAIL because price and stock currently render only the full synchronized table.

- [ ] **Step 3: Create a UI-only operation flow controller**

Export a browser global with this minimal API:

```js
window.MagaluOperationFlow = {
  parseSkuList(raw) { /* trim, split by comma/semicolon/newline, unique */ },
  create({ resource, resolveSelection, renderAction, requestPreview }) { /* bind the four UI stages */ }
};
```

The controller may call existing SKU selection resolution endpoints for catalog. For price and stock it must resolve requested identifiers through existing account-scoped catalog APIs before rendering editable rows. It must never call a remote Magalu write, and it must emit selected changes only to the existing `/magalu/api/writes/preview` endpoint.

- [ ] **Step 4: Add the shared step markup and styles**

Use numbered headings and fixed class names for all three resource pages:

```html
<section class="mg-operation-step" data-step="selection"><span>1. Seleção</span></section>
<section class="mg-operation-step" data-step="action"><span>2. Ação</span></section>
<section class="mg-operation-step" data-step="review"><span>3. Revisão</span></section>
```

Keep the existing preview modal as step 4, confirmation. Ensure desktop supports a two-column selection/action workbench and mobile stacks in source order.

- [ ] **Step 5: Verify shared UI contract and no-write boundary**

Run: `node --check public/js/magalu-operation-flow.js; npm test -- tests/magalu-operation-flow-ui.test.js tests/sku-selection-input.test.js tests/protected-writes.test.js`

Expected: PASS and no test change to `writeExecutionService` or workers.

- [ ] **Step 6: Commit shared flow**

```bash
git add apps/seller-magalu/public/js/magalu-operation-flow.js apps/seller-magalu/views/app.html apps/seller-magalu/public/css/magalu-app.css apps/seller-magalu/tests/magalu-operation-flow-ui.test.js
git commit -m "Add shared Magalu operation selection flow"
```

## Task 5: Wire catalog, price and stock into the shared operation flow

**Files:**
- Modify: `apps/seller-magalu/public/js/magalu-sku-management.js`
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Test: `apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`
- Test: `apps/seller-magalu/tests/protected-writes.test.js`

- [ ] **Step 1: Add failing behavior contracts**

```js
test("price and stock send selected explicit SKUs only through the existing preview contract", () => {
  const client = read("public/js/magalu-app.js");
  assert.match(client, /MagaluOperationFlow\.create/);
  assert.match(client, /resource: "price"/);
  assert.match(client, /resource: "stock"/);
  assert.match(client, /\/magalu\/api\/writes\/preview/);
  assert.doesNotMatch(client, /portfolioWriteService|\/seller\/v1\/portfolios/);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npm test -- tests/magalu-operation-flow-ui.test.js`

Expected: FAIL because only direct checkbox collection exists.

- [ ] **Step 3: Replace page-specific selection collection**

For catalog, retain the existing guarded mass endpoints and `magalu-sku-management.js` preview/apply behavior. For price and stock, build `changes` only from resolved selection state and field values, then call the existing `previewWrite(resource)` path. Delete only the duplicate checkbox collector once the new shared controller is used.

Do not change these existing invariants:

```js
POST /magalu/api/writes/preview
POST /magalu/api/writes/apply
Hub WRITE force check in the worker
GET before dispatch
dispatching persistence
GET-only reconciliation for uncertain writes
```

- [ ] **Step 4: Verify guarded-write regression tests**

Run: `npm test -- tests/magalu-operation-flow-ui.test.js tests/sku-mass-management.test.js tests/sku-selection-input.test.js tests/protected-writes.test.js`

Expected: PASS.

- [ ] **Step 5: Commit wired flows**

```bash
git add apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/public/js/magalu-sku-management.js apps/seller-magalu/tests/magalu-operation-flow-ui.test.js
git commit -m "Unify Magalu protected operation flows"
```

## Task 6: Bring Magalu pricing to the Meli hierarchy without invented settlement data

**Files:**
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-financial.js`
- Modify: `apps/seller-magalu/public/css/magalu-app.css`
- Test: `apps/seller-magalu/tests/financial-meli-parity.test.js`

- [ ] **Step 1: Write failing pricing UI contracts**

```js
test("Magalu pricing presents coverage, filterable costs, filterable margin and a guided calculator", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-financial.js");
  assert.match(html, /id="mg-financial-cost-coverage"/);
  assert.match(html, /id="mg-financial-cost-search"/);
  assert.match(html, /id="mg-financial-margin-search"/);
  assert.match(html, /data-calculator-step="sale"/);
  assert.match(html, /data-calculator-step="fees"/);
  assert.match(html, /data-calculator-step="result"/);
  assert.match(html, /Financial Analysis/);
  assert.doesNotMatch(client, /fetch\([^)]*seller\/v1/i);
});
```

- [ ] **Step 2: Confirm RED**

Run: `npm test -- tests/financial-meli-parity.test.js`

Expected: FAIL because costs and margins are unfiltered tables and the calculator is one dense form.

- [ ] **Step 3: Implement UI-only financial hierarchy**

Use current financial APIs only. Add local search/filter controls, counts and coverage summaries to Costs and Margin. Group calculator fields into semantic panels:

```html
<fieldset data-calculator-step="sale"><legend>1. Venda e produto</legend></fieldset>
<fieldset data-calculator-step="fees"><legend>2. Taxas e entrega</legend></fieldset>
<fieldset data-calculator-step="expenses"><legend>3. Impostos e despesas</legend></fieldset>
<section data-calculator-step="result"><h2>4. Resultado da simulação</h2></section>
```

Keep every uncertain Magalu fee manual and labeled as an operator estimate. Do not add import/export/timeline UI because no backend contract is being delivered in this scope.

- [ ] **Step 4: Verify pricing tests**

Run: `node --check public/js/magalu-financial.js; npm test -- tests/financial-meli-parity.test.js tests/financial-pricing-ui.test.js tests/financial-pricing.test.js`

Expected: PASS.

- [ ] **Step 5: Commit financial hierarchy**

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/js/magalu-financial.js apps/seller-magalu/public/css/magalu-app.css apps/seller-magalu/tests/financial-meli-parity.test.js
git commit -m "Align Magalu pricing experience with Meli"
```

## Task 7: Full verification and publish readiness

**Files:**
- Modify only if required by failed verification: affected Magalu files and their focused tests.

- [ ] **Step 1: Run static checks**

Run:

```bash
node --check apps/seller-magalu/public/js/magalu-app.js
node --check apps/seller-magalu/public/js/magalu-operation-flow.js
node --check apps/seller-magalu/public/js/magalu-sku-management.js
node --check apps/seller-magalu/public/js/magalu-financial.js
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the full Magalu suite**

Run: `npm test`

Working directory: `apps/seller-magalu`

Expected: all tests pass.

- [ ] **Step 3: Perform authenticated visual acceptance**

Compare these pairs on desktop and mobile:

1. `/ml/painel` and `/magalu/`;
2. `/ml/gestao-anuncios` and `/magalu/gestao-skus`;
3. Meli price/stock operations and `/magalu/precos`, `/magalu/estoque`;
4. Meli pricing pages and `/magalu/custos`, `/magalu/margem`, `/magalu/calculadora`.

Verify the Magalu account selector changes all relevant data, no write can occur before preview/confirmation, and a missing scope remains an explanatory disabled state.

- [ ] **Step 4: Commit final fixes only after fresh evidence**

```bash
git status -sb
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/css/magalu-app.css apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/public/js/magalu-operation-flow.js apps/seller-magalu/public/js/magalu-sku-management.js apps/seller-magalu/public/js/magalu-financial.js apps/seller-magalu/src/controllers/dashboardController.js apps/seller-magalu/src/repositories/orderRepository.js apps/seller-magalu/src/repositories/catalogRepository.js apps/seller-magalu/src/repositories/financialRepository.js apps/seller-magalu/tests/meli-ux-shell-contract.test.js apps/seller-magalu/tests/dashboard-meli-parity.test.js apps/seller-magalu/tests/magalu-operation-flow-ui.test.js apps/seller-magalu/tests/financial-meli-parity.test.js
git commit -m "Complete Magalu Meli UX parity"
```

- [ ] **Step 5: Ask for explicit deployment approval**

Deployment rebuilds `seller-magalu-web` and may expose the UI to users. Do not deploy merely because tests pass.

