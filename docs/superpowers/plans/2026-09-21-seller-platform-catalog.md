# Seller Platform Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose only Mercado Livre, Shopee, and Tracking in the shared Seller selector, while retaining Hub authorization and independent entry journeys for Ads, Log, Madeira, and Leader.

**Architecture:** `apps/gateway/server.js` keeps serving the selector and protecting every direct `/go/*` route. The static selector declares only the three shared Seller cards; its existing client-side entitlement filter determines whether each remaining card is usable. The Ads Stage 6 regression is narrowed to assert the dedicated Ads route and login, rather than treating the Seller selector as an Ads entry point.

**Tech Stack:** Node.js built-in test runner, Express Gateway, static HTML/JavaScript.

---

### Task 1: Write failing selector-boundary tests

**Files:**
- Create: `tests/seller-platform-catalog.test.js`
- Modify: `tests/ads-hub-stage6.test.js:46-57`

- [ ] **Step 1: Add the selector contract test**

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

test("Seller selector exposes only shared Seller modules", () => {
  const source = fs.readFileSync(path.join(root, "apps/seller-ml/views/selecao-plataforma.html"), "utf8");
  const cards = Array.from(source.matchAll(/class="module-card" href="[^"]+" data-module="([^"]+)"/g), (match) => match[1]);

  assert.deepEqual(cards, ["ml", "shopee", "tracking"]);
  assert.doesNotMatch(source, /dach_ads:/);
  assert.doesNotMatch(source, /davanttilog:/);
  assert.doesNotMatch(source, /madeiramadeira:/);
  assert.doesNotMatch(source, /skuleader:/);
});

test("independent modules retain protected Gateway entry routes", () => {
  const source = fs.readFileSync(path.join(root, "apps/gateway/server.js"), "utf8");

  assert.match(source, /\/go\/ads/);
  assert.match(source, /\/go\/davanttilog/);
  assert.match(source, /\/go\/madeiramadeira/);
  assert.match(source, /\/go\/skuleader/);
});
```

- [ ] **Step 2: Update the old Ads assertion to express the new contract**

Replace `assert.match(selector, /data-module="dach_ads"/);` with `assert.doesNotMatch(selector, /data-module="dach_ads"/);`.

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test tests/seller-platform-catalog.test.js tests/ads-hub-stage6.test.js`

Expected: FAIL because the selector still declares Ads, Log, Madeira, and Leader cards and aliases.

### Task 2: Remove independent products from the shared Seller selector

**Files:**
- Modify: `apps/seller-ml/views/selecao-plataforma.html:673-707`
- Modify: `apps/seller-ml/views/selecao-plataforma.html:797-805`
- Test: `tests/seller-platform-catalog.test.js`

- [ ] **Step 1: Remove the four complete card blocks**

Delete the `<a class="module-card">` blocks having `data-module="davanttilog"`, `data-module="madeiramadeira"`, `data-module="skuleader"`, and `data-module="dach_ads"`. Do not change the `ml`, `shopee`, or `tracking` card blocks.

- [ ] **Step 2: Reduce the alias map to the remaining cards**

```js
const aliases = {
  ml: ["ml", "meli", "mercadolivre", "mercado_livre", "mercado-livre", "mercado livre"],
  shopee: ["shopee"],
  tracking: ["tracking", "rastreio", "logistica", "logística", "correios", "avantracking"]
};
```

Do not change Gateway route declarations: they retain server-side access enforcement for direct compatible paths.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run: `node --test tests/seller-platform-catalog.test.js tests/ads-hub-stage6.test.js`

Expected: PASS.

- [ ] **Step 4: Run adjacent access and architecture regressions**

Run: `node --test tests/gateway-product-boundary.test.js tests/suite-access-regression.test.js`

Expected: PASS.

### Task 3: Inspect the scoped result

**Files:**
- Modify: `apps/seller-ml/views/selecao-plataforma.html`
- Create: `tests/seller-platform-catalog.test.js`
- Modify: `tests/ads-hub-stage6.test.js`

- [ ] **Step 1: Inspect the diff**

Run: `git diff -- apps/seller-ml/views/selecao-plataforma.html tests/seller-platform-catalog.test.js tests/ads-hub-stage6.test.js docs/superpowers/specs/2026-09-21-seller-platform-catalog-design.md docs/superpowers/plans/2026-09-21-seller-platform-catalog.md`

Expected: four cards and their aliases removed; focused tests and DACH documentation added; no unrelated files staged or changed.
