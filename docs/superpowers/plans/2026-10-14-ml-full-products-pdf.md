# Full Products PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exportar exatamente os produtos exibidos na aba Produtos no Full em uma prévia imprimível com colunas selecionáveis e filtros aplicados no cabeçalho.

**Architecture:** Reaproveitar a geração de HTML imprimível existente em `full.js`, mantendo um conjunto próprio de campos e armazenamento para Produtos no Full. Os dados vêm de `state.products`, preenchido pela consulta atual, sem nova API. Guardar metadados da consulta aplicada junto com o resultado para que mudanças não submetidas no formulário não apareçam no PDF.

**Tech Stack:** HTML, JavaScript vanilla, Node.js `node:test`, impressão nativa do navegador.

---

### Task 1: Capturar o conjunto exibido e os filtros efetivos

**Files:**
- Modify: `apps/seller-ml/public/js/full.js`
- Test: `apps/seller-ml/tests/full-products-export-ui.test.js`

- [ ] **Step 1: Write the failing test.** Criar teste de contrato que verifica `state.productExportContext`, atualização apenas após resposta aceita de `loadProducts`/`syncFull`, e botão desabilitado quando `state.products` está vazio:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/js/full.js"), "utf8");

test("product export records applied filters and current row count", () => {
  assert.match(source, /productExportContext/);
  assert.match(source, /function updateProductExportButton\(/);
  assert.match(source, /if \(seq !== state\.requestSeq\) return;/);
});
```

- [ ] **Step 2: Verify RED.** Run `node --test tests/full-products-export-ui.test.js` from `apps/seller-ml`; expect failure for missing `productExportContext`.
- [ ] **Step 3: Implement the smallest state change.** Add `productExportContext: { q: "", sort: "suggested", totalCached: 0, lastSyncedAt: null }` to state. After an accepted `loadProducts` response, store its `q`, `sort`, `total_cached`, and `last_synced_at`; after `syncFull`, store the default query context matching the rows returned by sync. In `renderProducts`, call `updateProductExportButton()` and disable `btnExportFullProducts` when `state.products.length === 0`. Do not read current form values during export.
- [ ] **Step 4: Verify GREEN.** Run `node --test tests/full-products-export-ui.test.js`; expect pass. Add a runtime test with a stubbed DOM/fetch to prove an edited-but-unsubmitted search does not replace the recorded query, then repeat RED/GREEN.
- [ ] **Step 5: Commit only Task 1 files.** `git add apps/seller-ml/public/js/full.js apps/seller-ml/tests/full-products-export-ui.test.js` then `git commit -m "feat(ml): track displayed Full export scope"`.

### Task 2: Botão e prévia PDF de Produtos no Full

**Files:**
- Modify: `apps/seller-ml/views/full.html`
- Modify: `apps/seller-ml/public/js/full.js`
- Test: `apps/seller-ml/tests/full-products-export-ui.test.js`

- [ ] **Step 1: Write failing tests.** Extend the test file with assertions for `id="btnExportFullProducts"`, independent `fullProductsPdfExportFields` storage key, all ten columns from the spec, and a PDF scope warning when `totalCached > rows.length`. Add a browser/DOM test exercising click with `window.open` returning null and with a fake window; assert escaped title/SKU, current row order, applied filter labels, and selectable fields.
- [ ] **Step 2: Verify RED.** Run `node --test tests/full-products-export-ui.test.js`; expect the new tests to fail for the absent button/exporter.
- [ ] **Step 3: Implement the exporter.** Add `btnExportFullProducts` to the Produtos no Full card header. Define a `FULL_PRODUCTS_PDF_FIELDS` array with renderers for photo, product, SKU, MLB, stock, sold 7/15/30, revenue 30d, coverage, suggested restock and status. Use `escapeHtml` for all API text, including image URL and filter text. Build a dedicated print-preview function from `state.products` and `state.productExportContext`; reuse the existing print CSS/control pattern, but store field preferences under `fullProductsPdfExportFields`. Bind the button to open a blank tab synchronously and populate it, reporting popup blockage with `showError`. Bump the `full.js` cache-bust in `full.html`.
- [ ] **Step 4: Verify GREEN.** Run `node --test tests/full-products-export-ui.test.js`; expect pass. Verify `node --check public/js/full.js` and `git diff --check`.
- [ ] **Step 5: Commit only Task 2 files.** `git add apps/seller-ml/views/full.html apps/seller-ml/public/js/full.js apps/seller-ml/tests/full-products-export-ui.test.js` then `git commit -m "feat(ml): export displayed Full products to PDF preview"`.

### Task 3: Regression and visual review

**Files:**
- Verify: `apps/seller-ml/views/full.html`
- Verify: `apps/seller-ml/public/js/full.js`
- Verify: `apps/seller-ml/tests/full-products-export-ui.test.js`

- [ ] **Step 1: Run all Seller ML tests relevant to Full.** From `apps/seller-ml`, run `node --test tests/full-products-export-ui.test.js` and any existing tests matching `full*.test.js`; expect zero failures.
- [ ] **Step 2: Review the preview in a browser.** With populated products, apply a search and alternate ordering; verify row count/order, labels, selectable columns, print CSS, and the warning when cached count exceeds displayed count. Verify empty results disable the button.
- [ ] **Step 3: Confirm scope.** Run `git diff --check`, `git status --short`, and inspect the commits to ensure no unrelated files, secrets, backend routes, or migrations were added. No push or deploy without a separate user request.
