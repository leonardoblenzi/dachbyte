# Product Ads Read-only Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Seller/ML Publicidade screen into a clearer decision panel and replace unsupported campaign editing with safe read-only management.

**Architecture:** The current Product Ads data pipeline remains unchanged: existing campaign metrics, insights, filters and campaign focus navigation continue feeding the page. The client replaces the edit mutation with a contextual management modal and an external Mercado Livre action. The server leaves the legacy route available for compatibility but returns a deterministic 409 before authentication or upstream calls.

**Tech Stack:** Node.js CommonJS, Express, node:test, static HTML/CSS/JavaScript.

---

### Task 1: Block unsupported campaign writes at the service boundary

**Files:**
- Modify: `apps/seller-ml/services/ProductAdsService.js:2275-2314`
- Create: `apps/seller-ml/tests/product-ads-campaign-management.test.js`

- [ ] **Step 1: Write the failing service contract test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const ProductAdsService = require('../services/ProductAdsService');

test('campaign update reports unsupported capability without calling Mercado Livre', async () => {
  const result = await ProductAdsService.atualizarCampanha('123', { status: 'paused' });

  assert.deepEqual(result, {
    success: false,
    code: 'CAMPAIGN_MANAGEMENT_UNSUPPORTED',
    error: 'O Mercado Livre nao permite editar campanhas Product Ads por integracao.',
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails because the current service attempts authentication/upstream work**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: failure because the current method needs integration credentials instead of returning capability state.

- [ ] **Step 3: Replace the mutation implementation with the capability result**

```js
static async atualizarCampanha() {
  return {
    success: false,
    code: 'CAMPAIGN_MANAGEMENT_UNSUPPORTED',
    error: 'O Mercado Livre nao permite editar campanhas Product Ads por integracao.',
  };
}
```

- [ ] **Step 4: Run the service test and confirm it passes**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: `pass 1` and `fail 0`.

### Task 2: Expose the capability state as an explicit HTTP conflict

**Files:**
- Modify: `apps/seller-ml/controllers/PublicidadeController.js:22-50`
- Modify: `apps/seller-ml/tests/product-ads-campaign-management.test.js`

- [ ] **Step 1: Extend the failing test for the controller status mapping**

```js
const PublicidadeController = require('../controllers/PublicidadeController');

test('campaign update maps unsupported management to HTTP 409', async () => {
  const res = { locals: {}, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };

  await PublicidadeController.atualizarCampanha({ params: { id: '123' }, body: {} }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'CAMPAIGN_MANAGEMENT_UNSUPPORTED');
});
```

- [ ] **Step 2: Run the test and confirm it fails because the current mapper returns 502/400**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: the controller status assertion fails.

- [ ] **Step 3: Map the new result code to 409**

```js
case 'CAMPAIGN_MANAGEMENT_UNSUPPORTED':
  return res.status(409).json(payload);
```

- [ ] **Step 4: Run the contract test again**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: `pass 2` and `fail 0`.

### Task 3: Replace the edit form with a campaign-management modal

**Files:**
- Modify: `apps/seller-ml/views/publicidade.html:686-730`
- Modify: `apps/seller-ml/public/js/product-ads.js:4729-4801,5397-5419`
- Modify: `apps/seller-ml/tests/product-ads-campaign-management.test.js`

- [ ] **Step 1: Write a failing static contract test for the safe UI**

```js
const fs = require('node:fs');
const path = require('node:path');

test('campaign modal presents external management without a save action', () => {
  const html = fs.readFileSync(path.join(__dirname, '../views/publicidade.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/product-ads.js'), 'utf8');

  assert.match(html, /id="campaignManageExternalBtn"/);
  assert.doesNotMatch(html, /id="campaignEditSaveBtn"/);
  assert.match(script, /openMercadoLivreAdvertising/);
  assert.doesNotMatch(script, /patchCampaign\(campaignId, payload\)/);
});
```

- [ ] **Step 2: Run it and confirm it fails against the editable modal**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: assertion fails because `campaignEditSaveBtn` and `patchCampaign` still exist.

- [ ] **Step 3: Implement read-only markup and client behavior**

Replace editable inputs with semantic facts (`campaignManageName`, `campaignManageBudget`, `campaignManageRoas`, `campaignManageStatus`) and an explanatory callout. Bind `campaignManageExternalBtn` to `window.open('https://www.mercadolivre.com.br/advertising', '_blank', 'noopener,noreferrer')`; keep close/backdrop/Escape behavior and all existing entry points to `openCampaignEditModal`.

- [ ] **Step 4: Run the UI contract test**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: all Task 1–3 tests pass.

### Task 4: Rebalance the Publicidade KPI hierarchy without removing existing content

**Files:**
- Modify: `apps/seller-ml/public/css/product-ads.css:5362-5381`
- Modify: `apps/seller-ml/tests/product-ads-campaign-management.test.js`

- [ ] **Step 1: Add a failing CSS contract test for the executive/efficiency grouping**

```js
test('publicidade KPI layout reserves the first four cards for executive metrics', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/product-ads.css'), 'utf8');

  assert.match(css, /ads-premium__kpis > \.kpi:nth-child\(-n\+4\).*grid-column:span 3/);
  assert.match(css, /ads-premium__kpis > \.kpi:nth-child\(n\+5\).*grid-column:span 2/);
  assert.match(css, /@media \(max-width:1180px\)/);
});
```

- [ ] **Step 2: Run the test and confirm it fails after replacing the legacy layout selectors**

Run: `node --test apps/seller-ml/tests/product-ads-campaign-management.test.js`

Expected: failure until the final responsive selectors exist.

- [ ] **Step 3: Implement the selected B layout in the existing KPI grid**

Use the existing first four KPI cards as executive cards and the remaining metrics as secondary cards. Remove duplicate/conflicting legacy selector blocks, retain responsive breakpoints and add only layout styles; do not remove chart, insights, tables, navigation or planning content.

- [ ] **Step 4: Run the full focused suite and syntax checks**

Run:
```bash
node --test apps/seller-ml/tests/product-ads-campaign-management.test.js
node --check apps/seller-ml/services/ProductAdsService.js
node --check apps/seller-ml/controllers/PublicidadeController.js
node --check apps/seller-ml/public/js/product-ads.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Review the diff and commit the implementation**

Run:
```bash
git diff -- apps/seller-ml/services/ProductAdsService.js apps/seller-ml/controllers/PublicidadeController.js apps/seller-ml/views/publicidade.html apps/seller-ml/public/js/product-ads.js apps/seller-ml/public/css/product-ads.css apps/seller-ml/tests/product-ads-campaign-management.test.js
git add apps/seller-ml/services/ProductAdsService.js apps/seller-ml/controllers/PublicidadeController.js apps/seller-ml/views/publicidade.html apps/seller-ml/public/js/product-ads.js apps/seller-ml/public/css/product-ads.css apps/seller-ml/tests/product-ads-campaign-management.test.js docs/superpowers/plans/2026-09-23-product-ads-read-only-redesign.md
git commit -m "Redesign Product Ads campaign management"
```
