# Magalu Financial Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build isolated Magalu SKU-cost, margin-estimation and sales-price calculator screens.

**Architecture:** A Magalu-only pricing engine computes transparent estimates from manual commercial inputs. A repository persists account-scoped SKU costs and joins them to the existing catalog mirror. Routes remain Hub-gated through the existing Suite identity and never issue remote Magalu writes.

**Tech Stack:** Node.js, Express, PostgreSQL, vanilla JavaScript, canonical Seller Magalu shell.

---

### Task 1: Pricing engine

**Files:**
- Create: `apps/seller-magalu/src/services/magaluPricingEngine.js`
- Test: `apps/seller-magalu/tests/financial-pricing.test.js`

- [ ] Write tests for total cost, profit, margin, ROI, break-even and target price.
- [ ] Run `node --test apps/seller-magalu/tests/financial-pricing.test.js` and verify RED.
- [ ] Implement numeric validation and the pure calculation.
- [ ] Run the test again and verify GREEN.

### Task 2: Storage and API

**Files:**
- Create: `apps/seller-magalu/db/migrations/011_financial_pricing.sql`
- Create: `apps/seller-magalu/src/repositories/financialRepository.js`
- Create: `apps/seller-magalu/src/controllers/financialController.js`
- Create: `apps/seller-magalu/src/routes/financial.routes.js`
- Modify: `apps/seller-magalu/src/routes/api.routes.js`

- [ ] Add failing repository/controller contract assertions.
- [ ] Create account/SKU-scoped cost storage and joins to `magalu.skus`/`magalu.prices`.
- [ ] Add READ-gated costs, margins, lookup and calculator routes.
- [ ] Run targeted tests.

### Task 3: Magalu UI

**Files:**
- Create: `apps/seller-magalu/public/js/magalu-financial.js`
- Create: `apps/seller-magalu/public/css/magalu-financial.css`
- Modify: `apps/seller-magalu/views/app.html`
- Modify: `apps/seller-magalu/src/routes/index.js`
- Test: `apps/seller-magalu/tests/financial-pricing-ui.test.js`

- [ ] Write failing shell/page contract test.
- [ ] Add Financeiro navigation and three account-aware canonical-shell sections.
- [ ] Add UI behavior for costs, margins and the local calculator.
- [ ] Run UI and pricing tests, then complete suite.
