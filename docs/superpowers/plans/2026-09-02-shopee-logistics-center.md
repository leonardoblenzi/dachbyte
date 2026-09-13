# Shopee Logistics Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Shopee Central Logistica as a guided, accessible workflow that supports seller logistics paired with either SPX/Expresso Aereo or Grande/Pesado, validates live channel availability, and applies the same rules to spreadsheet mapping.

**Architecture:** Extend the existing channel analyzer with a separate `heavy` kind, place all compatibility decisions in a pure domain policy, and make both legacy and new controller actions consume that policy. Keep the current vanilla HTML/CSS/JS application, but move pure browser-side selection and spreadsheet rules into a testable helper while the existing `app.js` remains responsible for API calls, rendering, pagination, modals, and progress.

**Tech Stack:** Node.js CommonJS, Express, PostgreSQL repositories, vanilla HTML/CSS/JavaScript, SheetJS/XLSX, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-shopee-logistics-center-design.md`

## Global Constraints

- `logistics_channel_id: 91006` is Expresso Aereo and must always behave as SPX.
- Allowed managed states are seller only, seller plus SPX, or seller plus Grande/Pesado.
- SPX/Expresso Aereo and Grande/Pesado must never be enabled together.
- SPX or Grande/Pesado requires seller logistics to be selected and available for that exact listing.
- Never synthesize a Shopee channel that is absent from the live listing response.
- Preserve raw channel objects and all unmanaged channels in update payloads.
- Keep existing logistics endpoints and the existing two-column spreadsheet format compatible.
- New confirmations must use the platform modal, not `window.confirm`.
- No database migration is expected.
- Visual QA must not execute a real Shopee write; intercept write requests.

---

## File Structure

- Modify `shopee/src/utils/productLogistics.js`: classify and summarize Grande/Pesado separately.
- Create `shopee/src/domain/logisticsConfigurationPolicy.js`: normalize, validate, and build managed target channel payloads.
- Modify `shopee/src/controllers/LogisticsController.js`: expose live availability, add unified configuration, and align legacy actions.
- Modify `shopee/src/routes/logistics.routes.js`: register the unified configuration route.
- Modify `shopee/src/jobs/asyncProcessAction.job.js`: execute queued unified configuration jobs.
- Modify `shopee/src/services/AsyncProcessActionQueueService.js`: allow the new queue action.
- Modify `shopee/src/repositories/processExecutionSqlRepository.js`: label the new action in process history.
- Modify `shopee/src/services/shopeeCreditCosts.js`: assign the existing logistics credit cost to the action.
- Create `shopee/public/js/logistics-center-rules.js`: pure browser rules for selection and spreadsheet pre-validation.
- Modify `shopee/public/index.html`: replace logistics subtabs and markup, and load the browser rules helper.
- Modify `shopee/public/app.js`: render the guided workflow, use platform modals, call queue APIs, and export/import Grande/Pesado.
- Modify `shopee/public/styles.css`: responsive logistics layout and explicit selected states in dark/light themes.
- Modify `shopee/test/productLogistics.test.js`: channel classification coverage.
- Create `shopee/test/logisticsConfigurationPolicy.test.js`: compatibility and payload policy coverage.
- Create `shopee/test/logisticsCenterUi.test.js`: browser helper and spreadsheet rule coverage.

---

### Task 1: Classify Grande/Pesado as its own channel family

**Files:**
- Modify: `shopee/src/utils/productLogistics.js`
- Modify: `shopee/test/productLogistics.test.js`

**Interfaces:**
- Produces: `identifyChannelKind(channel) -> "spx" | "heavy" | "intelipost" | "pickup" | "other"`.
- Produces: `analyzeLogistics(raw)` fields `heavyChannels`, `heavyChannel`, `heavyEnabled`, `sellerEnabled`, `availableKinds`, and `enabledKinds`.
- Preserves: `SPX_LOGISTICS_CHANNEL_IDS = {80012, 91003, 91006}` and raw channel objects.

- [ ] **Step 1: Write failing heavy-channel tests**

Add cases that prove exact separation from seller and SPX:

```js
test("identifies Entrega de Item Grande/Pesado as heavy", () => {
  assert.equal(identifyChannelKind({
    logistics_channel_id: 99123,
    logistics_channel_name: "Entrega de Item Grande/Pesado",
    enabled: true,
  }), "heavy");
});

test("summarizes heavy and seller without marking SPX", () => {
  const analysis = analyzeLogistics([
    { logistics_channel_name: "Entrega de Item Grande/Pesado", enabled: true },
    { logistics_channel_name: "Logistica do vendedor - Intelipost", enabled: true },
  ]);
  assert.equal(analysis.heavyEnabled, true);
  assert.equal(analysis.sellerEnabled, true);
  assert.equal(analysis.spxEnabled, false);
  assert.deepEqual(analysis.enabledKinds.sort(), ["heavy", "intelipost"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/productLogistics.test.js
```

Expected: the first test receives `other`, and heavy summary fields are absent.

- [ ] **Step 3: Implement normalized heavy detection and summaries**

Recognize names containing normalized combinations of `grande` plus `pesado`, `item grande`, `large and bulky`, or `bulky delivery` before the generic seller check. Add heavy collections and derived kind lists without changing raw payloads.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test test/productLogistics.test.js`.

Expected: all product logistics tests pass, including IDs 91003 and 91006.

- [ ] **Step 5: Commit the channel classification**

```powershell
git add shopee/src/utils/productLogistics.js shopee/test/productLogistics.test.js
git commit -m "feat(shopee): classify heavy logistics channels"
```

---

### Task 2: Centralize compatibility and target-payload policy

**Files:**
- Create: `shopee/src/domain/logisticsConfigurationPolicy.js`
- Create: `shopee/test/logisticsConfigurationPolicy.test.js`

**Interfaces:**
- Consumes: `analyzeLogistics(raw)` from Task 1.
- Produces: `normalizeTargetKinds(values) -> Array<"seller" | "spx" | "heavy" | "pickup">`.
- Produces: `validateTargetKinds({ targetKinds, analysis }) -> { ok, targetKinds, errors, missingKinds }`.
- Produces: `buildTargetLogistics({ logistics, targetKinds }) -> { ok, targetKinds, logistics, errors, missingKinds, changed }`.

- [ ] **Step 1: Write the complete policy matrix as failing tests**

Cover seller-only, seller+SPX, seller+heavy, missing seller, SPX+heavy, unavailable channels, unmanaged-channel preservation, and already-configured state.

```js
const {
  analyzeLogistics,
  identifyChannelKind,
} = require("../src/utils/productLogistics");

function fixtureChannels() {
  return [
    { logistics_channel_name: "Logistica do vendedor", enabled: false },
    { logistics_channel_id: 91003, logistics_channel_name: "Shopee Xpress", enabled: false },
    { logistics_channel_id: 99123, logistics_channel_name: "Entrega de Item Grande/Pesado", enabled: false },
    { logistics_channel_id: 77777, logistics_channel_name: "Canal parceiro", name: "Canal parceiro", enabled: true },
  ];
}

function availableAnalysis(kinds) {
  return analyzeLogistics(fixtureChannels().filter((channel) => {
    const kind = identifyChannelKind(channel);
    const publicKind = kind === "intelipost" ? "seller" : kind;
    return kinds.includes(publicKind) || kind === "other";
  }));
}

function enabled(logistics, kind) {
  const internalKind = kind === "seller" ? "intelipost" : kind;
  return logistics.some((channel) =>
    identifyChannelKind(channel) === internalKind && channel.enabled === true,
  );
}

test("rejects SPX and heavy together", () => {
  const result = validateTargetKinds({
    targetKinds: ["seller", "spx", "heavy"],
    analysis: availableAnalysis(["seller", "spx", "heavy"]),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /nao pode ser combinado/i);
});

test("builds seller plus heavy and preserves unmanaged channels", () => {
  const result = buildTargetLogistics({
    logistics: fixtureChannels(),
    targetKinds: ["seller", "heavy"],
  });
  assert.equal(result.ok, true);
  assert.equal(enabled(result.logistics, "heavy"), true);
  assert.equal(enabled(result.logistics, "intelipost"), true);
  assert.equal(enabled(result.logistics, "spx"), false);
  assert.equal(result.logistics.find((row) => row.name === "Canal parceiro").enabled, true);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run `node --test test/logisticsConfigurationPolicy.test.js`.

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure policy module**

Use `analyzeLogistics`, map public `seller` to channel kind `intelipost`, and only toggle managed channel kinds. Return stable error codes alongside messages:

```js
{
  code: "spx_heavy_conflict" | "seller_required" | "channel_unavailable",
  message: "...",
  kinds: ["spx"]
}
```

- [ ] **Step 4: Run policy and product logistics tests**

Run:

```powershell
node --test test/productLogistics.test.js test/logisticsConfigurationPolicy.test.js
```

Expected: both files pass.

- [ ] **Step 5: Commit the policy**

```powershell
git add shopee/src/domain/logisticsConfigurationPolicy.js shopee/test/logisticsConfigurationPolicy.test.js
git commit -m "feat(shopee): enforce logistics combinations"
```

---

### Task 3: Add unified backend configuration and align legacy actions

**Files:**
- Modify: `shopee/src/controllers/LogisticsController.js`
- Modify: `shopee/src/routes/logistics.routes.js`
- Create: `shopee/test/logisticsControllerConfiguration.test.js`

**Interfaces:**
- Consumes: `buildTargetLogistics({ logistics, targetKinds })` from Task 2.
- Produces route: `POST /shops/active/logistics/configure` with `{ itemIds: string[], targetKinds: string[] }`.
- Produces response: `{ ok, totalRequested, success, failed, activeTotals, results[] }`.
- Extends list response with `products.all`, `heavy.enabled`, `heavy.eligible`, and `heavy.unavailable`.

- [ ] **Step 1: Extract a dependency-injected configuration worker and write failing tests**

Add an exported test helper with this exact signature:

```js
configureProducts({
  products,
  liveInfoByItemId,
  targetKinds,
  shopShopeeId,
  updateRemote,
  updateLocal,
})
```

Tests must prove one remote write per eligible listing, no write for unavailable seller/heavy, individual errors for partial failure, and local cache update only after remote success.

- [ ] **Step 2: Run controller tests and verify RED**

Run `node --test test/logisticsControllerConfiguration.test.js`.

Expected: `configureProducts` is missing.

- [ ] **Step 3: Implement `configureProducts` and `configure`**

Resolve live information first, call the policy per listing, preserve product title/status metadata, call `ShopeeLogisticsService.updateProductLogistics`, then persist `buildSpxSnapshot(...).cache`. Include `availableKinds`, `enabledKinds`, and policy errors in each result.

- [ ] **Step 4: Align legacy endpoints with the policy**

- `enableSpx` targets `["seller", "spx"]` and no longer defaults to disabling seller.
- `enableSellerLogistics` allows seller to coexist with existing SPX or heavy.
- `disableSellerLogistics` rejects a listing while SPX or heavy remains enabled, with an actionable message.
- conflict repair helpers remain callable for old process records but stop treating seller+SPX as a conflict.

- [ ] **Step 5: Extend the list response**

Return all active summarized products once and derive grouped views without extra live API calls:

```js
{
  products: { all: summarized },
  spx: { enabled, eligible, unavailable },
  heavy: { enabled, eligible, unavailable },
  seller: { enabled, eligible, unavailable }
}
```

- [ ] **Step 6: Register the route and run focused tests**

Run:

```powershell
node --test test/productLogistics.test.js test/logisticsConfigurationPolicy.test.js test/logisticsControllerConfiguration.test.js
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit backend configuration**

```powershell
git add shopee/src/controllers/LogisticsController.js shopee/src/routes/logistics.routes.js shopee/test/logisticsControllerConfiguration.test.js
git commit -m "feat(shopee): configure logistics by target state"
```

---

### Task 4: Queue unified configuration and preserve process accounting

**Files:**
- Modify: `shopee/src/jobs/asyncProcessAction.job.js`
- Modify: `shopee/src/services/AsyncProcessActionQueueService.js`
- Modify: `shopee/src/repositories/processExecutionSqlRepository.js`
- Modify: `shopee/src/services/shopeeCreditCosts.js`
- Modify: `shopee/public/app.js`

**Interfaces:**
- Produces async action: `logistics.configure`.
- Consumes payload: `{ itemIds, targetKinds }`.
- Uses controller: `LogisticsController.configure`.

- [ ] **Step 1: Export read-only registrations and add a failing registration test**

Export the existing allowlist, worker map, process labels, and credit-cost map under a `__test` object without changing runtime behavior. Extend `shopee/test/logisticsControllerConfiguration.test.js` to assert that every exported registration contains `logistics.configure`.

- [ ] **Step 2: Run the test and verify RED**

Run `node --test test/logisticsControllerConfiguration.test.js`.

Expected: missing `logistics.configure` registration.

- [ ] **Step 3: Register the action in all four backend maps**

Use label `Configuracao guiada de logistica` and the same `shopee.async.logistics` credit key as existing logistics actions.

- [ ] **Step 4: Add frontend process labels**

Add `logistics.configure` to `PROCESS_ACTION_LABELS` and endpoint pattern mappings in `app.js` so the global process dock names it consistently.

- [ ] **Step 5: Run the focused test and commit**

```powershell
node --test test/logisticsControllerConfiguration.test.js
git add shopee/src/jobs/asyncProcessAction.job.js shopee/src/services/AsyncProcessActionQueueService.js shopee/src/repositories/processExecutionSqlRepository.js shopee/src/services/shopeeCreditCosts.js shopee/public/app.js shopee/test/logisticsControllerConfiguration.test.js
git commit -m "feat(shopee): queue guided logistics changes"
```

---

### Task 5: Add testable browser selection and spreadsheet rules

**Files:**
- Create: `shopee/public/js/logistics-center-rules.js`
- Create: `shopee/test/logisticsCenterUi.test.js`
- Modify: `shopee/public/index.html`

**Interfaces:**
- Produces global/CommonJS object `LogisticsCenterRules`.
- Produces `normalizeKinds(raw)`, `toggleTargetKind(currentKinds, kind)`, `validateKinds(kinds)`, and `parseMappingKinds(raw)`.
- `toggleTargetKind` returns `{ targetKinds, removedKinds, sellerPromptRequired }`.

- [ ] **Step 1: Write failing browser-rule tests**

```js
test("selecting heavy removes SPX and asks for seller", () => {
  const result = rules.toggleTargetKind(["spx"], "heavy");
  assert.deepEqual(result.targetKinds, ["heavy"]);
  assert.deepEqual(result.removedKinds, ["spx"]);
  assert.equal(result.sellerPromptRequired, true);
});

test("spreadsheet accepts Grande/Pesado with seller", () => {
  const parsed = rules.parseMappingKinds(
    "Entrega de Item Grande/Pesado, Logistica do vendedor",
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.kinds.sort(), ["heavy", "seller"]);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run `node --test test/logisticsCenterUi.test.js`.

Expected: module-not-found failure.

- [ ] **Step 3: Implement the UMD-style pure helper**

Expose with both:

```js
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.LogisticsCenterRules = api;
```

Keep labels and validation codes aligned with the backend policy.

- [ ] **Step 4: Load the helper before `app.js` and run tests**

Run `node --test test/logisticsCenterUi.test.js`.

Expected: all UI rule tests pass.

- [ ] **Step 5: Commit browser rules**

```powershell
git add shopee/public/js/logistics-center-rules.js shopee/public/index.html shopee/test/logisticsCenterUi.test.js
git commit -m "feat(shopee): add logistics selection rules"
```

---

### Task 6: Rebuild Central Logistica markup and interaction flow

**Files:**
- Modify: `shopee/public/index.html`
- Modify: `shopee/public/app.js`
- Modify: `shopee/public/styles.css`

**Interfaces:**
- Consumes: `GET /shops/active/logistics/products` extended response.
- Consumes: `window.LogisticsCenterRules` from Task 5.
- Enqueues: `logistics.configure` with `{ itemIds, targetKinds }`.

- [ ] **Step 1: Replace subtabs with the approved information architecture**

Create tabs with IDs:

```text
logistics-tab-configure
logistics-tab-heavy
logistics-tab-seller
logistics-tab-mapping
```

Use icon buttons only for refresh/close where familiar symbols exist, include tooltips, and keep text buttons for `Revisar e aplicar`, `Baixar modelo`, and `Processar mapeamento`.

- [ ] **Step 2: Add stable channel selectors and filters**

Render three fixed-dimension selector buttons with `data-logistics-target-kind`, `aria-pressed`, availability state, icon, title, and status. Add segmented filters `Todos`, `Prontos para aplicar`, `Ja configurados`, and `Com impedimento`.

- [ ] **Step 3: Render one searchable configuration table**

Use the existing ID/name search behavior and multi-ID selection. Each row must show current channels, SPX eligibility, per-channel availability, proposed state, and a readable blocking reason.

- [ ] **Step 4: Implement seller prompt and conflict replacement with platform modal**

Add a Promise-based modal adapter around the existing modal markup:

```js
const accepted = await openPlatformConfirmation({
  title: "Habilitar Logistica do vendedor?",
  message: "SPX e Grande/Pesado exigem este canal para os anuncios selecionados.",
  confirmLabel: "Habilitar junto",
});
```

Do not use `window.confirm` in the new configure, heavy, or mapping flows.

- [ ] **Step 5: Add review and application summary**

The review modal must display total selected, applicable, already configured, and blocked, plus the target combination. Confirming enqueues `logistics.configure`; closing performs no request.

- [ ] **Step 6: Build the dedicated Grande/Pesado view**

Show counters and filters for enabled, available, and unavailable products. Provide actions for enable with seller, disable heavy while preserving seller, and replace SPX with heavy after explicit confirmation.

- [ ] **Step 7: Preserve process progress and refresh state**

Reuse `startLogisticsProcess`, `appendLogisticsProcessLog`, queue polling, and `loadLogistics`. Keep selected IDs only while the filtered products remain present; clear successful IDs after completion.

- [ ] **Step 8: Add responsive and light-theme styles**

Use explicit classes `.logistics-channel-selector.is-selected`, `.is-unavailable`, `.logistics-row.is-selected`, and `.logistics-action-bar`. In light mode provide border, background, check icon, and focus ring with at least 3:1 component contrast and readable text contrast. At widths below 820px, stack selectors and keep the action bar within the viewport.

- [ ] **Step 9: Run syntax and complete unit tests**

Run:

```powershell
node --check public/app.js
node --check public/js/logistics-center-rules.js
node --test test/*.test.js
```

Expected: syntax checks exit 0 and all tests pass.

- [ ] **Step 10: Commit the guided UI**

```powershell
git add shopee/public/index.html shopee/public/app.js shopee/public/styles.css
git commit -m "feat(shopee): rebuild logistics center workflow"
```

---

### Task 7: Extend spreadsheet mapping and logistics export

**Files:**
- Modify: `shopee/src/controllers/LogisticsController.js`
- Modify: `shopee/public/app.js`
- Modify: `shopee/public/index.html`
- Modify: `shopee/test/logisticsConfigurationPolicy.test.js`
- Modify: `shopee/test/logisticsCenterUi.test.js`

**Interfaces:**
- Spreadsheet input remains `ID do anuncio` plus `Tipo de Logistica`.
- Adds accepted mapped kind `heavy`.
- Export adds heavy/seller/SPX enabled and available columns.

- [ ] **Step 1: Add failing parser and policy tests for all template rows**

Test these exact values:

```text
Logistica do vendedor
Shopee Xpress, Logistica do vendedor
Expresso Aereo, Logistica do vendedor
Entrega de Item Grande/Pesado, Logistica do vendedor
```

Also assert rejection of `Shopee Xpress, Entrega de Item Grande/Pesado, Logistica do vendedor` and `Grande/Pesado` without seller.

- [ ] **Step 2: Run parser/policy tests and verify RED**

Run:

```powershell
node --test test/logisticsConfigurationPolicy.test.js test/logisticsCenterUi.test.js
```

Expected: heavy spreadsheet cases fail until both parsers are extended.

- [ ] **Step 3: Route backend mapping through the central policy**

Make `applyAutomaticMapping` normalize each row to target kinds and call the same per-product configuration worker used by `/configure`. Remove independent toggling rules that can diverge.

- [ ] **Step 4: Update template, preview, and export**

The template contains only the four valid examples. Preview statuses are `Valido`, `Configuracao invalida`, or `Canal indisponivel`. Export columns include:

```text
spx_habilitado
spx_disponivel
grande_pesado_habilitado
grande_pesado_disponivel
logistica_vendedor_habilitada
logistica_vendedor_disponivel
configuracao_atual
impedimento
```

Retain package dimension and weight columns already exported.

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
node --test test/logisticsConfigurationPolicy.test.js test/logisticsCenterUi.test.js test/logisticsControllerConfiguration.test.js
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit spreadsheet support**

```powershell
git add shopee/src/controllers/LogisticsController.js shopee/public/app.js shopee/public/index.html shopee/test/logisticsConfigurationPolicy.test.js shopee/test/logisticsCenterUi.test.js
git commit -m "feat(shopee): support heavy logistics spreadsheets"
```

---

### Task 8: Browser verification and final regression gate

**Files:**
- Modify only files found defective during verification.
- Create: `output/playwright/logistics-center-qa.md`

**Interfaces:**
- Reads the completed UI and intercepts write endpoints.
- Produces a concise QA record with viewport/theme/scenario results.

- [ ] **Step 1: Confirm Playwright CLI and start the local Shopee application**

From Git Bash, verify the required CLI dependency:

```bash
command -v npx >/dev/null 2>&1
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" --help
```

From PowerShell in `shopee/`, start only the Express application in a persistent terminal on a dedicated port. Requiring `src/app` directly avoids starting the queue workers and scheduled services from `src/server.js`:

```powershell
$env:PORT='3107'
$env:NODE_ENV='test'
node -e "const createApp=require('./src/app'); const server=createApp().listen(3107,'127.0.0.1',()=>console.log('UI QA http://127.0.0.1:3107')); process.on('SIGINT',()=>server.close(()=>process.exit(0)))"
```

Use `http://127.0.0.1:3107`. Keep credentials in the existing local `.env`; do not change or print them. Stop immediately if requiring `src/app` starts a worker or emits an unexpected write.

- [ ] **Step 2: Use Playwright CLI with intercepted API responses**

Intercept:

```text
GET **/shops/active/logistics/products
POST **/processes/jobs
POST **/shops/active/logistics/configure
```

Fixture data must include seller+SPX, seller+heavy, seller-only, missing seller, and unavailable heavy listings. Abort the run if an unmocked logistics write is attempted.

Open headed Chromium, snapshot before every interaction group, and store screenshots/traces under `output/playwright/`:

```bash
"$PWCLI" open http://127.0.0.1:3107 --headed
"$PWCLI" tracing-start
"$PWCLI" snapshot
```

- [ ] **Step 3: Verify desktop dark and light themes**

At 1440x900, capture and inspect configure, heavy, seller, and spreadsheet tabs. Confirm selected controls remain visible in light mode, no overlap occurs, sticky actions remain reachable, and disabled reasons are legible.

- [ ] **Step 4: Verify mobile dark and light themes**

At 390x844, verify selectors stack, table scrolling is contained, text does not overflow buttons, tabs remain reachable, and the confirmation modal fits the viewport.

- [ ] **Step 5: Verify interaction rules without writes**

Exercise SPX then heavy replacement, seller prompt acceptance/refusal, unavailable seller blocking, multi-ID search, filter segments, spreadsheet preview, and confirmation cancellation. Confirm only the mocked queue request occurs after final confirmation.

- [ ] **Step 6: Iterate visually with Playwright Interactive when available**

Create the QA inventory required by `playwright-interactive`, covering every selector, tab, modal outcome, filter, theme, and viewport above plus these off-happy-path cases: the selected listing loses channel availability after refresh; a mixed selection contains applicable and blocked listings. Reuse persistent desktop and mobile contexts while refining CSS. If `js_repl` is unavailable in this session, record that limitation and complete the same inventory with Playwright CLI snapshots and screenshots instead of silently skipping it.

- [ ] **Step 7: Record QA and run final tests**

Write `output/playwright/logistics-center-qa.md` with each scenario marked pass/fail and screenshot filenames. Stop tracing with `"$PWCLI" tracing-stop`. Then run:

```powershell
node --check public/app.js
node --check public/js/logistics-center-rules.js
node --test test/*.test.js
git diff --check
```

Expected: all commands exit 0 and no failed QA scenario remains.

- [ ] **Step 8: Commit final QA fixes and record**

Return to the repository root, then run:

```powershell
git add shopee/public shopee/src shopee/test output/playwright/logistics-center-qa.md
git commit -m "test(shopee): verify guided logistics center"
```
