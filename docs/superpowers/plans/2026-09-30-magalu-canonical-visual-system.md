# Seller Magalu Canonical Visual System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Seller Magalu route use the Margem de venda visual system while preserving all existing operational behavior.

**Architecture:** Add a small canonical visual layer after the existing Magalu stylesheets, then migrate page markup only where a page cannot consume that layer. The layer standardizes hero, filters, decision surfaces, tabs, state blocks and dialogs; it never changes APIs, OAuth, queues or protected-write services.

**Tech Stack:** Static HTML, CSS custom properties, vanilla JavaScript, Node.js built-in test runner.

---

## File map

- Modify: `apps/seller-magalu/views/app.html` — add canonical semantic classes to page sections and use one modal class.
- Create: `apps/seller-magalu/public/css/magalu-canonical-ui.css` — visual primitives and responsive rules, loaded last.
- Modify: `apps/seller-magalu/public/css/magalu-rich-workspaces.css` — remove only feature-level rules superseded by the canonical primitives.
- Modify: `apps/seller-magalu/public/css/magalu-promotions.css` — consume canonical filter, surface and modal classes.
- Modify: `apps/seller-magalu/public/js/magalu-loading.js` — expose a page-local loading state without changing request semantics.
- Modify: `apps/seller-magalu/public/js/magalu-app.js` — apply route-local loading attributes around existing route loads.
- Modify: `apps/seller-magalu/tests/ui-canonical-visual.test.js` — source-contract tests for the shared system.

## Task 1: Define the canonical primitives

**Files:**
- Create: `apps/seller-magalu/public/css/magalu-canonical-ui.css`
- Modify: `apps/seller-magalu/views/app.html:8-22`
- Test: `apps/seller-magalu/tests/ui-canonical-visual.test.js`

- [ ] **Step 1: Write the failing visual-contract test**

```js
test("canonical Magalu layer defines hero, filter, surface, tabs, state and modal primitives", () => {
  const css = read("public/css/magalu-canonical-ui.css");
  const html = read("views/app.html");
  for (const selector of [".mg-ui-hero", ".mg-ui-filter-card", ".mg-ui-surface", ".mg-ui-tabs", ".mg-ui-state", ".mg-ui-modal"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\\\.")));
  }
  assert.match(html, /magalu-canonical-ui\\.css\\?v=/);
});
```

- [ ] **Step 2: Run the test and confirm the missing-file failure**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: failure because `magalu-canonical-ui.css` does not exist.

- [ ] **Step 3: Add the primitives and load them last**

```css
.mg-ui-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:20px 22px;border:1px solid var(--mg-border);border-radius:18px;background:var(--mg-surface);box-shadow:var(--mg-shadow-sm)}
.mg-ui-filter-card{padding:18px 20px;border:1px solid var(--mg-border);border-radius:16px;background:var(--mg-surface);box-shadow:var(--mg-shadow-sm)}
.mg-ui-surface{padding:22px;border:1px solid var(--mg-border);border-radius:20px;background:var(--mg-surface);box-shadow:var(--mg-shadow-sm)}
.mg-ui-tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--mg-border);border-radius:14px;background:var(--mg-surface)}
.mg-ui-state{padding:34px;text-align:center;color:var(--mg-muted)}
.mg-ui-modal{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;background:rgba(3,8,20,.54);backdrop-filter:blur(2px)}
.mg-ui-modal[hidden]{display:none!important}
```

Add this final stylesheet link after `magalu-loading.css`:

```html
<link rel="stylesheet" href="/magalu/assets/css/magalu-canonical-ui.css?v=2026093002">
```

- [ ] **Step 4: Run the test and syntax-safe checks**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the foundation**

```bash
git add apps/seller-magalu/public/css/magalu-canonical-ui.css apps/seller-magalu/views/app.html apps/seller-magalu/tests/ui-canonical-visual.test.js
git commit -m "feat: add canonical Magalu visual primitives"
```

## Task 2: Migrate commercial and catalogue routes

**Files:**
- Modify: `apps/seller-magalu/views/app.html:174-276`
- Modify: `apps/seller-magalu/public/css/magalu-sku-management.css`
- Modify: `apps/seller-magalu/public/css/magalu-orders.css`
- Test: `apps/seller-magalu/tests/ui-canonical-visual.test.js`

- [ ] **Step 1: Write the failing route-markup test**

```js
test("catalogue, orders and SKU management use canonical page surfaces", () => {
  const html = read("views/app.html");
  for (const page of ["mg-catalog-page", "mg-orders-page", "mg-sku-management-page"]) {
    assert.match(html, new RegExp(`id="${page}"[\\s\\S]*?mg-ui-hero`));
  }
  assert.match(html, /mg-catalog-page[\\s\\S]*?mg-ui-filter-card/);
  assert.match(html, /mg-orders-page[\\s\\S]*?mg-ui-filter-card/);
});
```

- [ ] **Step 2: Run the test and confirm the markup failure**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: failure until each page receives the canonical classes.

- [ ] **Step 3: Add semantic classes without changing element IDs or actions**

```html
<section class="mg-page-hero mg-ui-hero">…</section>
<section class="mg-filter-card mg-ui-filter-card">…</section>
<section class="mg-section-card mg-ui-surface">…</section>
```

For SKU Management, retain the three-step selection/action/review structure and apply `mg-ui-hero` only to its header. For Orders, retain the scope banner and protected delivery controls.

- [ ] **Step 4: Remove conflicting spacing only from feature styles**

```css
/* Feature layout remains; canonical classes own border, radius, surface and padding. */
.mg-sku-management .mg-ui-surface{margin-top:18px}
.mg-orders-page .mg-ui-filter-card{margin-top:0}
```

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/ui-canonical-visual.test.js tests/sku-mass-management.test.js tests/orders-etapa7.test.js`

Expected: PASS.

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/css/magalu-sku-management.css apps/seller-magalu/public/css/magalu-orders.css apps/seller-magalu/tests/ui-canonical-visual.test.js
git commit -m "feat: standardize Magalu commercial workspaces"
```

## Task 3: Migrate operational and promotions routes

**Files:**
- Modify: `apps/seller-magalu/views/app.html:277-417`
- Modify: `apps/seller-magalu/public/css/magalu-operations.css`
- Modify: `apps/seller-magalu/public/css/magalu-promotions.css`
- Test: `apps/seller-magalu/tests/ui-canonical-visual.test.js`

- [ ] **Step 1: Write the failing test for canonical operations and promotion UI**

```js
test("prices, stock and promotions use canonical filters, states and modals", () => {
  const html = read("views/app.html");
  for (const page of ["mg-price-page", "mg-stock-page", "mg-promotions-page"]) {
    assert.match(html, new RegExp(`id="${page}"[\\s\\S]*?mg-ui-hero`));
  }
  assert.match(html, /mg-promotions-filter-card mg-ui-filter-card/);
  assert.match(html, /id="mg-promotions-detail" class="mg-promotions-dialog mg-ui-modal"/);
});
```

- [ ] **Step 2: Run and confirm the markup failure**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: failure before migration.

- [ ] **Step 3: Apply canonical classes and preserve protected flows**

```html
<section class="mg-page-hero mg-ui-hero">…</section>
<section class="mg-promotions-filter-card mg-ui-filter-card">…</section>
<section class="mg-promotions-dialog mg-ui-modal" id="mg-promotions-detail" hidden>…</section>
```

Keep every preview, confirmation, write-readiness and reconciliation control unchanged. Promoções remains read-only and does not gain an action button.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test tests/ui-canonical-visual.test.js tests/promotions-readonly.test.js tests/protected-writes.test.js`

Expected: PASS.

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/css/magalu-operations.css apps/seller-magalu/public/css/magalu-promotions.css apps/seller-magalu/tests/ui-canonical-visual.test.js
git commit -m "feat: standardize Magalu operational workspaces"
```

## Task 4: Harmonize pricing and account routes

**Files:**
- Modify: `apps/seller-magalu/views/app.html:419-487`
- Modify: `apps/seller-magalu/public/css/magalu-rich-workspaces.css`
- Modify: `apps/seller-magalu/public/css/magalu-account.css`
- Test: `apps/seller-magalu/tests/ui-canonical-visual.test.js`

- [ ] **Step 1: Write the failing test for the remaining pages**

```js
test("pricing and account routes retain the Margin standard through canonical primitives", () => {
  const html = read("views/app.html");
  for (const page of ["mg-financial-costs-page", "mg-financial-margin-page", "mg-financial-calculator-page", "mg-accounts-page", "mg-sync-page"]) {
    assert.match(html, new RegExp(`id="${page}"[\\s\\S]*?mg-ui-hero`));
  }
  assert.match(html, /mg-margin-filter-card mg-ui-filter-card/);
});
```

- [ ] **Step 2: Run and confirm the test fails**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: failure until all listed pages opt in.

- [ ] **Step 3: Assign canonical classes and keep financial semantics**

```html
<section class="mg-rich-hero mg-ui-hero">…</section>
<section class="mg-margin-filter-card mg-ui-filter-card">…</section>
<aside class="mg-calculator-result mg-calculator-card mg-ui-surface">…</aside>
```

Do not alter the margin limitations, calculator fields, account access requirements or integration diagnostics.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test tests/ui-canonical-visual.test.js tests/financial-pricing-ui.test.js tests/account-management.test.js`

Expected: PASS.

```bash
git add apps/seller-magalu/views/app.html apps/seller-magalu/public/css/magalu-rich-workspaces.css apps/seller-magalu/public/css/magalu-account.css apps/seller-magalu/tests/ui-canonical-visual.test.js
git commit -m "feat: harmonize Magalu pricing and account surfaces"
```

## Task 5: Make loading and route states consistent

**Files:**
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Modify: `apps/seller-magalu/public/js/magalu-promotions.js`
- Test: `apps/seller-magalu/tests/ui-canonical-visual.test.js`

- [ ] **Step 1: Write the failing behavior/source test**

```js
test("all route loaders use the shared Magalu loading contract", () => {
  const shell = read("public/js/magalu-app.js");
  const promotions = read("public/js/magalu-promotions.js");
  assert.match(shell, /MagaluLoadingOverlay\\?\\.show/);
  assert.match(promotions, /MagaluSellerShell\\?\\.fetchJson/);
  assert.doesNotMatch(promotions, /fetch\\(`\\/magalu\\/api\\/promotions/);
});
```

- [ ] **Step 2: Run and confirm the test fails**

Run: `node --test tests/ui-canonical-visual.test.js`

Expected: failure because Promoções still calls `fetch` directly.

- [ ] **Step 3: Route Promoções through the shell fetch helper**

```js
const payload = await window.MagaluSellerShell.fetchJson(
  `/magalu/api/promotions?account_id=${encodeURIComponent(accountId)}${suffix}`,
);
```

Keep the grid-level loading copy, but let the shell control the global loading overlay. Preserve credentials, session handling and GET-only behavior through `fetchJson`.

- [ ] **Step 4: Run source tests, syntax checks and commit**

Run: `node --test tests/ui-canonical-visual.test.js tests/promotions-readonly.test.js; node --check public/js/magalu-app.js; node --check public/js/magalu-promotions.js`

Expected: PASS.

```bash
git add apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/public/js/magalu-promotions.js apps/seller-magalu/tests/ui-canonical-visual.test.js
git commit -m "feat: unify Magalu route loading states"
```

## Task 6: Full regression and manual responsive acceptance

**Files:**
- Modify only if a failing check identifies an implementation defect.

- [ ] **Step 1: Verify static integrity**

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 2: Run the complete Seller Magalu suite**

Run: `npm test`

Working directory: `apps/seller-magalu`

Expected: every test passes with zero failures.

- [ ] **Step 3: Perform visual acceptance in an authenticated browser**

Check desktop wide, desktop collapsed sidebar, 900px, and 620px for `/magalu/`, `/magalu/catalogo`, `/magalu/pedidos`, `/magalu/gestao-skus`, `/magalu/precos`, `/magalu/estoque`, `/magalu/promocoes`, `/magalu/custos`, `/magalu/margem`, `/magalu/calculadora`, `/magalu/contas` and `/magalu/integracoes`.

Expected: no horizontal page overflow, hero/filter/surface spacing matches Margem, and all visible action controls retain their original behavior.

- [ ] **Step 4: Commit any verified correction separately**

```bash
git add <verified-files>
git commit -m "fix: resolve Magalu canonical UI regression"
```

Only create this commit if a manual acceptance defect was found and fixed.
