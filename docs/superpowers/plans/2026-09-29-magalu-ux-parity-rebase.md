# Magalu UX Parity Rebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase the Magalu UX parity package onto current `main` without changing runtime, OAuth, Hub or protected-write behavior.

**Architecture:** Current Magalu JavaScript is the source of truth for state and safety. Merge only the package's scoped presentation layer and reapply its HTML/route hooks manually. Never import Seller ML code.

**Tech Stack:** Express-rendered HTML, vanilla JavaScript, scoped CSS, Node test runner.

---

### Task 1: Product canvas and isolation contracts

**Files:**
- Create: `apps/seller-magalu/tests/ux-parity-product-system.test.js`
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Test: `apps/seller-magalu/tests/dashboard-meli-parity.test.js`

- [ ] Write a failing product-canvas contract that expects `mg-product-page` on dashboard, orders, SKU management, price, stock and all pricing routes; assert no `seller-ml`, `ml-shell`, or `/ml/` runtime dependency.
- [ ] Run `node --test tests/ux-parity-product-system.test.js` and confirm the new hooks fail before implementation.
- [ ] Add presentation-only route classes and `data-route-key`/`data-magalu-route` attributes without changing route resolution, account selection, preview, or write requests.
- [ ] Run `node --test tests/ux-parity-product-system.test.js tests/dashboard-meli-parity.test.js tests/magalu-operation-flow-ui.test.js`; expect PASS.
- [ ] Commit with `git commit -m "Add Magalu product canvas parity"`.

### Task 2: Scoped visual-system rebase

**Files:**
- Modify: `apps/seller-magalu/public/css/magalu-ml-parity.css`
- Modify: `apps/seller-magalu/public/css/magalu-sku-management.css`
- Modify: `apps/seller-magalu/public/css/magalu-orders.css`
- Modify: `apps/seller-magalu/public/css/magalu-financial.css`
- Modify: `apps/seller-magalu/views/app.html`

- [ ] Add failing contracts for a 262px/92px shell, product canvas, Seller-token dark theme, and absence of `prefers-color-scheme`/ML selectors.
- [ ] Run `node --test tests/ux-parity-product-system.test.js`; expect FAIL.
- [ ] Rebase CSS component by component: product canvas, tables, action bars, sticky selection, status surfaces, modals, responsive breakpoints and theme tokens. Keep every selector `.mg-*` scoped and do not style `body`.
- [ ] Bump each changed CSS asset version in `app.html`.
- [ ] Run `node --test tests/ux-parity-product-system.test.js && git diff --check`; expect PASS.

### Task 3: Pricing UX without losing resilience

**Files:**
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-financial.js`
- Modify: `apps/seller-magalu/tests/financial-meli-parity.test.js`

- [ ] Add failing contracts for three `mg-financial-tabs`, row semantic classes (`mg-financial-cost-input`, `mg-financial-chip`, `marginTone`) and current debounce behavior.
- [ ] Run `node --test tests/financial-meli-parity.test.js`; expect FAIL.
- [ ] Add Cost/Margin/Calculator internal navigation and Magalu-local row presentation. Preserve explicit user-entered fees, debounce, loading, last-valid-result handling and no remote calculator writes.
- [ ] Run `node --test tests/financial-meli-parity.test.js tests/financial-pricing-ui.test.js`; expect PASS.

### Task 4: Operational workbench presentation

**Files:**
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/public/js/magalu-app.js`
- Modify: `apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

- [ ] Add failing contracts for Selection, Action and Preview presentation surfaces, sticky selected-items context and consistent empty/error states.
- [ ] Run `node --test tests/magalu-operation-flow-ui.test.js tests/protected-writes.test.js`; expect only the new presentation assertions to fail.
- [ ] Rebase the workbench visuals while retaining exact SKU matching, isolated modes, account-change clearing, current-page disclosure, preview confirmation, Hub check, live GET, stale guard and reconciliation behavior.
- [ ] Run `node --test tests/magalu-operation-flow-ui.test.js tests/protected-writes.test.js tests/sku-selection-input.test.js`; expect PASS.

### Task 5: Integration verification

**Files:**
- Modify: only affected Magalu contract tests for intentional asset version updates

- [ ] Run `node --check public/js/magalu-app.js`, `node --check public/js/magalu-financial.js`, `npm test`, and `git diff --check`; expect all tests green and no whitespace errors.
- [ ] Confirm `git status -sb` has only intended Magalu/docs changes; never stage backups, `.codex`, or package files.
- [ ] Commit the integration with `git commit -m "Rebuild Magalu UX parity with Seller ML"`.
- [ ] Obtain authenticated desktop/mobile visual acceptance on dashboard, SKU management, prices, stock, orders, costs, margin and calculator before push/deploy.
