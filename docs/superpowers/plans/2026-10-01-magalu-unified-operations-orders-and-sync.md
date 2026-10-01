# Magalu Unified Operations, Orders and Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize the selection and review experience of Catalog, Price and Stock; clarify Orders; and make catalog synchronization idempotent with stable inline progress.

**Architecture:** Preserve every protected-write backend control. The Seller Magalu shell owns a common SKU-selection contract. Catalog sync uses an account-specific queue reservation and silent status polling.

**Tech Stack:** Node.js, Express, BullMQ, Redis, vanilla JavaScript, Node test runner.

---

### Task 1: Deduplicate catalog synchronization

**Files:**
- Modify: `apps/seller-magalu/src/queues/magaluQueue.js:17`
- Modify: `apps/seller-magalu/src/controllers/catalogController.js:118-134`
- Modify: `apps/seller-magalu/tests/account-resource-enforcement.test.js`

- [ ] **Step 1: Write the failing regression test**

```js
test("catalog sync reuses an active job", async () => {
  // Stub a running account and enqueueCatalogSync returning scheduled:false.
  // Assert HTTP 202, already_running:true, and no setCatalogSyncState call.
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/account-resource-enforcement.test.js`

Expected: FAIL because `catalogController.sync` always sets the account to `queued`.

- [ ] **Step 3: Make catalog jobs account-specific and reusable**

```js
const jobId = `magalu-catalog-full-${id}`;
const existing = await q.getJob(jobId);
if (existing && ["waiting", "active", "delayed", "prioritized"].includes(await existing.getState())) {
  return { id: existing.id, scheduled: false };
}
if (existing) await existing.remove();
const job = await q.add("full-sync", payload, { jobId, removeOnComplete: true, removeOnFail: 500, attempts: 2, backoff: { type: "exponential", delay: 15000 } });
return { id: job.id, scheduled: true };
```

Guard the inspection-plus-add interval with the current Redis connection and delete only the lock token owned by this invocation.

- [ ] **Step 4: Return the reused state from the controller**

```js
if (job.scheduled) await accountRepository.setCatalogSyncState(account.id, { status: "queued", error: null });
return res.status(202).json({ ok: true, job_id: job.id, account_id: account.id, already_running: !job.scheduled });
```

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/account-resource-enforcement.test.js tests/catalog-readonly.test.js`

Commit: `git add apps/seller-magalu/src/queues/magaluQueue.js apps/seller-magalu/src/controllers/catalogController.js apps/seller-magalu/tests/account-resource-enforcement.test.js`

Commit message: `fix: deduplicate Magalu catalog sync jobs`

### Task 2: Keep sync progress inline and polling silent

**Files:**
- Modify: `apps/seller-magalu/public/js/magalu-app.js:74-100,711-752`
- Modify: `apps/seller-magalu/tests/magalu-loading-overlay.test.js`

- [ ] **Step 1: Write the failing UI contract test**

```js
test("catalog polling skips the modal loader", () => {
  const app = read("public/js/magalu-app.js");
  assert.match(app, /catalog\/status[\s\S]{0,180}loading:\s*["']none["']/);
  assert.match(app, /already_running/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/magalu-loading-overlay.test.js`

Expected: FAIL because every `fetchJson` call opens the modal.

- [ ] **Step 3: Add a loading policy to the shared fetch wrapper**

```js
async function fetchJson(url, options = {}) {
  const { loading = "modal", ...requestOptions } = options;
  if (loading === "modal") window.MagaluLoadingOverlay?.show({ message: "Carregando dados da conta Magalu..." });
  try { return await requestJson(url, requestOptions); }
  finally { if (loading === "modal") window.MagaluLoadingOverlay?.hide(); }
}
```

- [ ] **Step 4: Use silent status polling**

Add `syncStarting:false` to state. Disable `[data-sync]` while posting, render `already_running` as “acompanhando a execução atual”, and call catalog status with `{ loading:"none" }`. Update only `setSyncBanner` between polls; refresh catalog/history once when the result is terminal.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/magalu-loading-overlay.test.js tests/magalu-operation-flow-ui.test.js`

Commit: `git add apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/tests/magalu-loading-overlay.test.js`

Commit message: `fix: keep Magalu sync progress inline`

### Task 3: Give Price and Stock the Catalog selection model

**Files:**
- Modify: `apps/seller-magalu/views/app.html:278-324`
- Modify: `apps/seller-magalu/public/js/magalu-app.js:475-610`
- Modify: `apps/seller-magalu/public/css/magalu-rich-workspaces.css:59-180`
- Modify: `apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

- [ ] **Step 1: Write failing common-contract tests**

```js
test("catalog price and stock share selection source and sticky summary", () => {
  for (const resource of ["sku", "price", "stock"]) {
    assert.match(html, new RegExp(`data-operation-select="${resource}"`));
    assert.match(html, new RegExp(`data-operation-selection-summary="${resource}"`));
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/magalu-operation-flow-ui.test.js`

Expected: FAIL because Price and Stock currently load arbitrary rows straight into editors.

- [ ] **Step 3: Replace Price and Stock selection markup**

```html
<section class="mg-operation-stage" data-operation-select="price">
  <!-- Catálogo atual, Inserir SKU, Colar lista -->
  <!-- filter card and checkbox table -->
  <aside class="mg-operation-selection-summary" data-operation-selection-summary="price"></aside>
</section>
```

Use this exact order for price and stock. Price configuration exposes current price, requested price and list price. Stock configuration exposes current and requested quantity. Their existing preview endpoints remain unchanged.

- [ ] **Step 4: Normalize selection state**

```js
state.operationSelection = {
  price: { mode:"filters", rows:[], selected:new Set(), filters:{ q:"", status:"", active:"" }, limit:100 },
  stock: { mode:"filters", rows:[], selected:new Set(), filters:{ q:"", status:"", active:"" }, limit:100 },
};
```

Resolve SKU/list modes into the same checkbox table, honor the backend safe limit, and feed only selected rows to existing `collectChanges(resource)` and preview calls.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/magalu-operation-flow-ui.test.js tests/sku-selection-input.test.js tests/protected-writes.test.js`

Commit: `git add apps/seller-magalu/views/app.html apps/seller-magalu/public/js/magalu-app.js apps/seller-magalu/public/css/magalu-rich-workspaces.css apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

Commit message: `feat: unify Magalu price and stock selection`

### Task 4: Align Catalog labels and feedback

**Files:**
- Modify: `apps/seller-magalu/public/js/magalu-sku-management.js:32-185`
- Modify: `apps/seller-magalu/views/app.html:262-276`
- Modify: `apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

- [ ] **Step 1: Write the failing stage-label test**

```js
test("every operation presents selection configuration and review stages", () => {
  for (const label of ["Selecione os SKUs", "Configure a alteração", "Revise e confirme"]) assert.match(html, new RegExp(label));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/magalu-operation-flow-ui.test.js`

Expected: FAIL because Catalog calls its configuration stage “Escolha a ação”.

- [ ] **Step 3: Standardize without changing Catalog security**

Keep `activate/deactivate` and `/sku-management/preview` plus `/sku-management/apply`. Use the common labels, selection summary, disabled state, safe-limit copy and empty/loading/error surfaces.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/magalu-operation-flow-ui.test.js tests/sku-mass-management.test.js`

Commit: `git add apps/seller-magalu/public/js/magalu-sku-management.js apps/seller-magalu/views/app.html apps/seller-magalu/tests/magalu-operation-flow-ui.test.js`

Commit message: `fix: align Magalu catalog operation feedback`

### Task 5: Make Orders explain its real state

**Files:**
- Modify: `apps/seller-magalu/views/app.html:180-260`
- Modify: `apps/seller-magalu/public/js/magalu-orders.js:33-66`
- Modify: `apps/seller-magalu/public/css/magalu-rich-workspaces.css`
- Modify: `apps/seller-magalu/tests/orders-etapa7.test.js`

- [ ] **Step 1: Write the failing UI-state test**

```js
test("Orders distinguishes scopes unsynced and empty states", () => {
  assert.match(read("views/app.html"), /mg-orders-state/);
  assert.match(read("public/js/magalu-orders.js"), /orders-state-(?:scopes|unsynced|empty)/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/orders-etapa7.test.js`

Expected: FAIL because generic zero KPIs and an empty table represent all three conditions today.

- [ ] **Step 3: Render an explicit primary state**

```js
function setOrdersState(kind, data) {
  // scopes: missing scope names and reconnect link
  // unsynced: lookback, last run and sync CTA
  // empty: completed sync interval with no orders
  // ready: KPIs, filters and table
}
```

Move sync and delivery-operation histories to collapsed `<details>` sections. Preserve order detail, reconciliation, NF-e and delivery-finalization guards exactly as they are.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/orders-etapa7.test.js`

Commit paths: `apps/seller-magalu/views/app.html`, `apps/seller-magalu/public/js/magalu-orders.js`, `apps/seller-magalu/public/css/magalu-rich-workspaces.css`, `apps/seller-magalu/tests/orders-etapa7.test.js`

Commit message: `feat: clarify Magalu orders readiness states`

### Task 6: Full verification and release preparation

**Files:**
- Modify: `apps/seller-magalu/views/app.html:490-510` only to version frontend assets that were changed.

- [ ] **Step 1: Run syntax and focused tests**

Run these commands separately from `apps/seller-magalu`: `node --check public/js/magalu-app.js`; `node --check public/js/magalu-sku-management.js`; `node --check public/js/magalu-orders.js`; `node --test tests/magalu-loading-overlay.test.js tests/magalu-operation-flow-ui.test.js tests/orders-etapa7.test.js tests/account-resource-enforcement.test.js`.

Expected: all checks pass.

- [ ] **Step 2: Run complete validation**

Run `npm test`, then `git diff --check`, then `git status -sb`.

Expected: full suite passes and unrelated untracked folders remain unstaged.

- [ ] **Step 3: Version only assets actually changed and commit**

Update query-string versions in `views/app.html` for changed JavaScript and CSS. Stage only those changed frontend files and use commit message `chore: refresh Magalu operation assets`.
