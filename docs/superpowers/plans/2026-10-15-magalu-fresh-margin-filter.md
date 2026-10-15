# Magalu Fresh Margin Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Filtrar refresh Magalu orders and financial reports before showing margin results, with accurate loading and incomplete-data handling.

**Architecture:** A margin-specific queued sync fetches orders for the selected interval, related delivery items, and financial reports. The UI polls the job, displays the existing Magalu overlay, and loads margin only after the job succeeds. SQL uses delivery items only when order items are unavailable and item coverage can be verified.

**Tech Stack:** Node.js/Express, BullMQ/Redis, PostgreSQL, vanilla JavaScript, `node --test`.

---

### Task 1: Bounded order sync for a margin period

**Files:** `apps/seller-magalu/src/services/orderSyncService.js`, `apps/seller-magalu/src/services/orderRemoteService.js`, `apps/seller-magalu/tests/margin-fresh-order-sync.test.js`.

- [ ] Add a failing test for a two-page order list that stops after the selected starting date, persists recent orders, and does not mark unrelated old orders absent.
- [ ] Run `node --test apps/seller-magalu/tests/margin-fresh-order-sync.test.js`; confirm the test fails because `syncOrdersForMarginRange` is absent.
- [ ] Add `syncOrdersForMarginRange(account, {from,to,onProgress})` to the order sync service. Validate dates with `dateWindows`, page the descending order list with the existing `listRows` and `nextOffset` helpers, save orders whose `purchased_at` is within the inclusive period, and stop only after an older row or the API's final page. Fetch deliveries for discovered channels using `syncDeliveriesForChannel` with the exact date bounds. If either source fails, reject rather than reporting success.
- [ ] Run the focused test and the existing `orders-etapa7.test.js`; confirm both pass.

### Task 2: Fresh-margin queue and scoped status API

**Files:** `apps/seller-magalu/src/services/marginFreshSyncService.js`, `apps/seller-magalu/src/config/queueNames.js`, `apps/seller-magalu/src/queues/magaluQueue.js`, `apps/seller-magalu/src/jobs/marginFreshSync.worker.js`, `apps/seller-magalu/src/worker.js`, `apps/seller-magalu/src/controllers/uxAnalyticsController.js`, `apps/seller-magalu/src/routes/uxAnalytics.routes.js`, `apps/seller-magalu/tests/margin-fresh-sync.test.js`.

- [ ] Add failing tests for invalid dates, missing scopes, duplicate clicks reusing one active account/period job, account isolation on status reads, and worker failure/success transitions.
- [ ] Run `node --test apps/seller-magalu/tests/margin-fresh-sync.test.js`; confirm each case fails for missing behavior.
- [ ] Build a BullMQ job keyed by account and date range. `POST /margins/sync` returns HTTP 202 with a job ID; `GET /margins/sync/:jobId` checks tenant and Hub account access, verifies the job's account ID, and returns state, stage, counts, error and completion time. The worker validates scopes, executes bounded order sync then `financialAnalysis.syncRange`, and marks complete only when both succeed. Report stages through `job.updateProgress` and use Redis job state for status; retain completed jobs long enough for polling and permit a later click to refresh again.
- [ ] Run focused tests and controller/route tests; confirm pass.

### Task 3: Financial calculation with delivery-item fallback

**Files:** `apps/seller-magalu/src/repositories/uxAnalyticsRepository.js`, `apps/seller-magalu/tests/margin-delivery-cost.test.js`.

- [ ] Add failing tests for one order with no `order_items` but one complete delivery item, duplicate delivery records, missing SKU, quantity mismatch, and absent cost. Assert the first computes CMV only with confirmed coverage; the others remain incomplete where coverage cannot be proven.
- [ ] Run `node --test apps/seller-magalu/tests/margin-delivery-cost.test.js`; confirm expected failures.
- [ ] Build a SQL item-source CTE that prefers `order_items`; otherwise uses active `delivery_items` joined by account and order, deduplicated by stable delivery/item identity. Require positive quantity, known SKU, and a count/quantity consistent with the order before setting `cost_complete`. Join `sku_costs` by account and SKU. Preserve null result/margin when any item or financial report is absent.
- [ ] Run focused tests and the existing margin analytics suite; confirm pass.

### Task 4: UI loading, polling and stale-data guard

**Files:** `apps/seller-magalu/public/js/magalu-financial.js`, `apps/seller-magalu/public/js/magalu-loading.js`, `apps/seller-magalu/tests/magalu-margin-fresh-ui.test.js`.

- [ ] Add failing tests that clicking Filtrar shows the overlay, polls only the returned job, changes stage copy, renders results only after completion, and keeps an error/stale label on failure. Test account or filter changes during polling and duplicate clicks.
- [ ] Run `node --test apps/seller-magalu/tests/magalu-margin-fresh-ui.test.js`; confirm expected failures.
- [ ] Update `applyMarginFilters` to capture a request token, disable the button, call POST sync, poll GET status with bounded delay, then load margins and equilibrium after completion. Use `MagaluLoadingOverlay.show/update/hide` in `try/finally`, with stage text but no invented percent. On failure keep prior cards marked stale or leave first-load panels awaiting filter, show retry action, and do not render a zero summary. Ignore responses whose token/account/filter snapshot no longer matches.
- [ ] Run focused UI tests and existing loading tests; confirm pass.

### Task 5: End-to-end verification and handoff

**Files:** No further production files unless a test exposes a defect.

- [ ] Run `npm test --workspace dachbyte-seller-magalu` from the repository root; confirm all tests pass.
- [ ] Run `git diff --check` and `git status --short`; confirm only intended files changed.
- [ ] Exercise a local account fixture with reports newer than orders, a missing-cost order, and a failed API call; verify no false zero margin or stale-success state.
- [ ] Summarize the work and evidence. Do not push or deploy without a new explicit request.
