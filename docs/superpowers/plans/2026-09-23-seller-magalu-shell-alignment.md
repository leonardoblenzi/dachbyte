# Seller Magalu Global Shell Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Magalu landing and legal pages render the global DACHBYTE Seller header.

**Architecture:** The brand theme mounts the global header from the `data-dx-shell` element. Magalu pages retain their Seller subnavigation and insert that element first in the body. The contract is protected by a Node built-in test.

**Tech Stack:** Static HTML, DACHBYTE brand theme, Node.js built-in test runner.

---

### Task 1: Define and implement the shell contract

**Files:**
- Modify: `tests/seller-magalu-public-pages.test.js`
- Modify: `apps/seller-ml/views/landing-magalu.html`
- Modify: `apps/seller-ml/views/legal-magalu-terms.html`
- Modify: `apps/seller-ml/views/legal-magalu-privacy.html`

- [ ] **Step 1: Write the failing test**

Add this test after the existing public-page tests.

```js
test("Magalu public journey mounts the canonical Seller global shell", () => {
  for (const fileName of [
    "landing-magalu.html",
    "legal-magalu-terms.html",
    "legal-magalu-privacy.html",
  ]) {
    assert.match(
      view(fileName),
      /<body>\s*<div data-dx-shell="seller" data-dx-module="Seller"><\/div>/,
      fileName,
    );
  }
});
```

- [ ] **Step 2: Verify the test is red**

Run: `node --test tests/seller-magalu-public-pages.test.js`

Expected: the new test fails because the three documents do not begin with the canonical shell mount.

- [ ] **Step 3: Add the canonical mount**

In each document, replace the opening body tag with the HTML below. Do not change the contextual navigation, links, copy, ticker, CTA, or footer.

```html
<body><div data-dx-shell="seller" data-dx-module="Seller"></div>
```

- [ ] **Step 4: Verify the test is green**

Run: `node --test tests/seller-magalu-public-pages.test.js`

Expected: all six tests pass, including the new global-shell contract.

- [ ] **Step 5: Run regression verification**

Run: `node --test tests/seller-landing-contract.test.js tests/seller-magalu-public-pages.test.js`

Then run: `git diff --check`

Expected: all tests pass and the diff check has no output.

- [ ] **Step 6: Commit the implementation**

Run: `git add tests/seller-magalu-public-pages.test.js apps/seller-ml/views/landing-magalu.html apps/seller-ml/views/legal-magalu-terms.html apps/seller-ml/views/legal-magalu-privacy.html`

Then run: `git commit -m "Align Magalu pages with Seller shell"`

### Task 2: Publish and verify the corrected journey

**Files:**
- No source-file changes.

- [ ] **Step 1: Push the committed main branch**

Run: `git push origin main`

Expected: the implementation commit is accepted by `origin/main`.

- [ ] **Step 2: Update the VPS checkout while preserving mode edits**

Run the three commands in this order: change to `/opt/dachbyte/repository`; stash only `infra/business-db-ops.sh` and `infra/business-production-ops.sh`; pull `origin main` with fast-forward only; then restore the stash.

Expected: the checkout advances and the two operational script mode edits remain present.

- [ ] **Step 3: Rebuild the shared Seller image serially**

Run: `docker compose --env-file ./env/compose.env -f compose.vps.yml build --no-cache gateway`

Then run: `docker compose --env-file ./env/compose.env -f compose.vps.yml up -d --no-deps --force-recreate gateway seller-ml-web seller-ml-worker`

Expected: Gateway and both Seller services are recreated from the current image. Build Gateway by itself because all three services share `dachbyte/seller:local`; concurrent builds can leave an older image tagged as current.

- [ ] **Step 4: Verify service health and public routes**

Run the compose `ps` command for `gateway`, `seller-ml-web`, and `seller-ml-worker`, then probe `/seller/magalu`, `/seller/magalu/termos`, and `/seller/magalu/privacidade` through local HTTPS with the production host override.

Expected: all three services report `healthy`; each route returns `200`.

## Deliberately deferred

The broader cleanup of visual variations across Mercado Livre, Shopee, Rastreio, and Magalu needs a separate comparison inventory and design approval. It must not change authenticated module flows or public routes incidentally.
