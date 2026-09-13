# Shopee Pricing V6 Catalog Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and reuse the Pricing V6 active catalog so overview and pagination remain fast, while comparing current discounted selling price and margin against the V6 suggestion.

**Architecture:** `PricingV6Snapshot` will hold one full calculated catalog per shop and pricing-settings version. The service will obtain that snapshot once, paginate/filter its saved items, and rebuild only on explicit refresh. The engine will model an optional tax rate as a seller cost, so suggested, current, and simulated sale-price calculations remain consistent.

**Tech Stack:** Node.js CommonJS, PostgreSQL JSONB snapshots, Express controllers, vanilla browser JavaScript, Node test runner.

## Global Constraints

- Cache only `NORMAL` Shopee listings and never call Shopee APIs from catalog preparation, overview, filters, or pagination.
- Persist a full catalog snapshot with no expiration; reuse it until `Atualizar dados` invalidates it or the V6 settings version changes.
- Current selling price is the lower active promotion price when it is positive and lower than normal price; otherwise use normal price.
- Tax rate is optional, validates from 0 to 100, and is deducted from revenue after coupon in every V6 calculation.
- Keep current external pricing V6 routes compatible; no migration is required because `PricingV6Snapshot.result` already stores JSON.

---

### Task 1: Add tax-aware V6 calculation primitives

**Files:**
- Modify: `shopee/src/services/PricingV6Engine.js:3-305`
- Modify: `shopee/src/services/PricingV6Service.js:20-125`
- Test: `shopee/test/pricingV6Engine.test.js`

**Interfaces:**
- Produces `normalizeSettings(settings).taxRate` as a fraction from 0 to 1.
- Produces `buildBreakdown(...).taxCents` and includes tax in `totalFeesCents`.
- Produces `calculateProduct(row, settings).currentBreakdown`, `currentMarginRate`, `currentNetPayoutCents`, and `currentEffectivePriceCents`.

- [ ] **Step 1: Write failing engine tests for tax and effective current price**

```js
test("deduz a aliquota da receita apos cupom", () => {
  const result = calculatePrice({
    costCents: 500,
    targetMarginRate: 0.1,
    settings: { ...DEFAULT_PRICING_SETTINGS, taxRate: 10, coupons: [], campaignEnabled: false },
  });
  assert.ok(result.breakdown.taxCents > 0);
  assert.ok(result.recommendedPriceCents > 0);
});

test("usa o preco promocional ativo como preco vigente", () => {
  const row = { currentPriceCents: 10000, activePromotionPriceCents: 8500, costCents: 3000 };
  const result = pricingServiceTest.calculateProduct(row, DEFAULT_PRICING_SETTINGS);
  assert.equal(result.currentEffectivePriceCents, 8500);
  assert.equal(result.currentDiscountPercent, 0.15);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: FAIL because `taxCents` and `currentEffectivePriceCents` do not exist.

- [ ] **Step 3: Implement the minimum tax and current-price calculation**

```js
const taxRate = normalizeRate(merged.taxRate, 0);
const taxCents = Math.round(revenueAfterCouponCents * normalizedSettings.taxRate);
const totalFeesCents = commissionCents + fixedFeeCents + campaignCents + variableCostCents + taxCents;

const currentEffectivePriceCents = row.activePromotionPriceCents > 0
  && row.activePromotionPriceCents < row.currentPriceCents
  ? row.activePromotionPriceCents
  : row.currentPriceCents;
```

Apply the same `taxRate` in the candidate equation used by `solveCandidates`, then calculate the current breakdown with `buildBreakdown`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit the calculation change**

```bash
git add shopee/src/services/PricingV6Engine.js shopee/src/services/PricingV6Service.js shopee/test/pricingV6Engine.test.js
git commit -m "feat(shopee): calculate V6 tax and current margin"
```

### Task 2: Persist and serve a full Pricing V6 catalog snapshot

**Files:**
- Modify: `shopee/src/services/PricingV6Service.js:128-432`
- Modify: `shopee/src/repositories/pricingV6SqlRepository.js:174-210`
- Modify: `shopee/src/controllers/PricingV6Controller.js:30-43`
- Test: `shopee/test/pricingV6Engine.test.js`

**Interfaces:**
- Produces `getCatalogSnapshot({ shopId, forceRefresh })` returning `{ snapshotId, reused, settings, summary, items }`.
- `listProducts({ shopId, filters, page, pageSize })` serves pages from `getCatalogSnapshot`.
- `getOverview({ shopId })` serves totals from `getCatalogSnapshot` and does not call `listPricingProducts` when a compatible snapshot exists.
- `GET /shops/:shopId/pricing/products` accepts `refresh=1` and `GET /pricing/overview` accepts `refresh=1`.

- [ ] **Step 1: Write failing service tests for durable catalog reuse**

```js
test("reutiliza o catalogo V6 no resumo e na paginacao", async () => {
  let productLoads = 0;
  const result = await pricingServiceTest.getCatalogSnapshotWithRepository({
    repository: cachedRepository,
    shopId: 7,
    loadRows: async () => { productLoads += 1; return [cachedProduct]; },
  });
  await pricingServiceTest.getCatalogSnapshotWithRepository({ repository: cachedRepository, shopId: 7, loadRows: async () => { productLoads += 1; return [cachedProduct]; } });
  assert.equal(productLoads, 1);
  assert.equal(result.items.length, 1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: FAIL because the catalog cache helper does not exist.

- [ ] **Step 3: Implement full catalog snapshot resolution and filter/page helpers**

```js
async function getCatalogSnapshot({ shopId, forceRefresh = false }) {
  const settings = await getSettings(shopId);
  return reuseOrCreatePreview({
    shopId,
    settingsVersion: settings.version,
    selection: { mode: "all", excludedKeys: [], filters: {} },
    filters: {},
    forceRefresh,
    buildResult: async () => buildCatalogResult(await repository.listPricingProducts({ shopId }), settings),
  });
}
```

`buildCatalogResult` must calculate each row once, convert it with `toSnapshotItem`, and derive all overview totals. `listProducts` must filter only `snapshot.items` and slice the selected page. `getOverview` must use the cached summary and only request recent jobs separately.

- [ ] **Step 4: Forward explicit refresh query flags in the controller**

```js
const forceRefresh = asBoolean(req.query?.refresh);
res.json(await PricingV6Service.getOverview({ shopId: shop.id, forceRefresh }));
```

Use the equivalent call in the products controller.

- [ ] **Step 5: Run service tests to verify the cache behavior passes**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: PASS and product loading happens once until `forceRefresh: true`.

- [ ] **Step 6: Commit the cache change**

```bash
git add shopee/src/services/PricingV6Service.js shopee/src/repositories/pricingV6SqlRepository.js shopee/src/controllers/PricingV6Controller.js shopee/test/pricingV6Engine.test.js
git commit -m "feat(shopee): cache the full V6 pricing catalog"
```

### Task 3: Present current price, current margin, and tax configuration

**Files:**
- Modify: `shopee/public/index.html:7230-7310`
- Modify: `shopee/public/app.js:21144-21620`
- Modify: `shopee/public/styles.css` in the Pricing V6 table rules
- Test: `shopee/test/pricingV6Engine.test.js`

**Interfaces:**
- The settings payload accepts and returns `taxRate` as a fraction; the UI edits it as percentage text.
- `renderPricingV6Products()` renders current price, discount information, current margin, suggested price, and suggested margin.
- `loadPricingV6Overview({ forceRefresh })` and `loadPricingV6Products({ resetPage, forceRefresh })` replace loading UI with a readable error message on failure.

- [ ] **Step 1: Write a failing contract test for tax serialization**

```js
test("publica a aliquota V6 como fracao e aceita percentual", () => {
  const settings = pricingServiceTest.publicSettings({ ...DEFAULT_PRICING_SETTINGS, taxRate: 10 });
  assert.equal(settings.taxRate, 0.1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: FAIL until the V6 settings mapping includes `taxRate`.

- [ ] **Step 3: Add settings and table markup**

```html
<label class="field"><span>Alíquota opcional (%)</span><input id="pricingV6TaxRate" class="input" type="number" min="0" max="100" step="0.01" placeholder="0,00" /></label>
```

Add `Preço atual`, `Margem atual`, `Preço sugerido`, and `Margem sugerida` headers. In the current-price cell, show the normal price on a muted line and `Promoção -X%` only when the effective price is promotional.

- [ ] **Step 4: Wire UI state, explicit refresh, and safe error rendering**

```js
const response = await apiGet(`/shops/active/pricing/overview${forceRefresh ? "?refresh=1" : ""}`);
setPricingV6Feedback("pricingV6SimulationFeedback", "Dados atualizados com o catalogo local.", "success");
```

Include `taxRate: Number(input.value || 0) / 100` when saving settings. Add `Imposto` to suggested/current/simulator breakdowns. In both overview and products loaders, catch errors locally, set the relevant text to `Não foi possível carregar...`, and preserve the refresh action.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `node --test shopee/test/pricingV6Engine.test.js`

Expected: PASS with V6 tax serialization covered.

- [ ] **Step 6: Commit the user interface change**

```bash
git add shopee/public/index.html shopee/public/app.js shopee/public/styles.css shopee/src/services/PricingV6Service.js shopee/test/pricingV6Engine.test.js
git commit -m "feat(shopee): compare cached V6 prices and margins"
```

### Task 4: Verify the full feature

**Files:**
- Test: `shopee/test/*.test.js`

- [ ] **Step 1: Run syntax validation for changed JavaScript**

Run: `node --check shopee/src/services/PricingV6Engine.js && node --check shopee/src/services/PricingV6Service.js && node --check shopee/public/app.js`

Expected: exit code 0.

- [ ] **Step 2: Run the complete Shopee test suite**

Run: `node --env-file='C:\Users\USER\PycharmProjects\davanttiSuite\shopee\src\.env' --test shopee/test/*.test.js`

Expected: all tests pass.

- [ ] **Step 3: Inspect the final diff and commit verification**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended Pricing V6 files changed.

- [ ] **Step 4: Commit final verification changes if needed**

```bash
git add shopee/test/pricingV6Engine.test.js
git commit -m "test(shopee): verify cached V6 pricing flow"
```
