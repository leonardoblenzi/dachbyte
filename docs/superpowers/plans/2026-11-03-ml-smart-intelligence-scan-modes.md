# ML SMART Intelligence Scan Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fast and complete SMART verification jobs that prove scan coverage, resume safely, and expose only fully verified opportunities for optimization.

**Architecture:** Keep Bull orchestration, ML authentication, optimization, and billing in `promoSmartOptimizerService.js`, but extract scan planning/pagination into a focused pure module and checkpoint persistence into a Redis-backed store. Both modes use the same engine; `quick` changes campaign priority and budget, while `full` exhausts pagination and retries. The browser submits a mode, polls the existing analysis endpoint, and renders coverage states separately from optimization safety.

**Tech Stack:** Node.js 20, CommonJS, Bull 4, ioredis, Express 5, vanilla browser JavaScript, HTML/CSS, Node test runner, ExcelJS.

---

## File map

- Create `apps/seller-ml/services/promoSmartScanEngine.js`: pure mode policy, campaign prioritization, pagination decisions, coverage classification, retry rounds, and scan orchestration through injected callbacks.
- Create `apps/seller-ml/services/promoSmartCheckpointStore.js`: account-scoped Redis checkpoints and expiration.
- Modify `apps/seller-ml/services/promoSmartOptimizerService.js`: adapt ML responses to the engine, publish job progress, resume checkpoints, classify results, protect optimization, and add coverage to XLSX.
- Modify `apps/seller-ml/routes/promocoesRoutes.js`: validate `mode`, accept continuation from a previous analysis, and expose coverage progress.
- Modify `apps/seller-ml/views/criar-promocao.html`: add mode choices, coverage panel, inconclusive filter, and continue-as-complete action.
- Modify `apps/seller-ml/public/js/promo-intelligence.js`: submit modes, render progress/coverage, and keep inconclusive results unselectable.
- Modify `apps/seller-ml/public/css/promocoes.css`: style mode cards, coverage states, and responsive layout.
- Create `apps/seller-ml/tests/promo-smart-scan-engine.test.js`: deterministic engine and pagination tests.
- Create `apps/seller-ml/tests/promo-smart-checkpoint-store.test.js`: checkpoint isolation, expiration, and continuation tests.
- Create `apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`: route/service/UI safety contract tests.
- Modify `apps/seller-ml/package.json`: add a focused test command.

### Task 1: Build the pure scan policy and pagination engine

**Files:**
- Create: `apps/seller-ml/services/promoSmartScanEngine.js`
- Create: `apps/seller-ml/tests/promo-smart-scan-engine.test.js`

- [ ] **Step 1: Write failing tests for mode policy and prioritization**

Create tests that establish the public contract:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../services/promoSmartScanEngine");

test("normalizes only quick and full modes", () => {
  assert.equal(Engine.normalizeMode("quick"), "quick");
  assert.equal(Engine.normalizeMode("full"), "full");
  assert.throws(() => Engine.normalizeMode("turbo"), /modo/i);
});

test("quick prioritizes active overlapping campaigns", () => {
  const rows = [
    { id: "future", status: "pending", start_date: "2026-12-01", finish_date: "2026-12-31" },
    { id: "active", status: "started", start_date: "2026-11-01", finish_date: "2026-11-30" },
  ];
  assert.deepEqual(Engine.planCampaigns(rows, { mode: "quick", now: "2026-11-03T12:00:00Z" }).map((x) => x.id), ["active", "future"]);
});

test("full preserves every relevant campaign", () => {
  const rows = [{ id: "a", status: "started" }, { id: "b", status: "pending" }];
  assert.equal(Engine.planCampaigns(rows, { mode: "full" }).length, 2);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test apps/seller-ml/tests/promo-smart-scan-engine.test.js`

Expected: FAIL with `Cannot find module '../services/promoSmartScanEngine'`.

- [ ] **Step 3: Implement mode policy and deterministic planning**

Create the module with explicit policy data:

```js
"use strict";

const POLICIES = Object.freeze({
  quick: Object.freeze({ maxDurationMs: 120000, maxPagesPerCampaign: 20, retryRounds: 1 }),
  full: Object.freeze({ maxDurationMs: 0, maxPagesPerCampaign: 250, retryRounds: 3 }),
});

function normalizeMode(value) {
  const mode = String(value || "quick").trim().toLowerCase();
  if (!Object.hasOwn(POLICIES, mode)) throw new Error("Modo de verificação SMART inválido.");
  return mode;
}

function statusRank(status) {
  return String(status || "").toLowerCase() === "started" ? 0 : 1;
}

function planCampaigns(campaigns, { mode = "quick" } = {}) {
  const normalized = normalizeMode(mode);
  const rows = [...(Array.isArray(campaigns) ? campaigns : [])];
  if (normalized === "full") return rows;
  return rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

module.exports = { POLICIES, normalizeMode, planCampaigns };
```

- [ ] **Step 4: Add failing pagination-decision tests**

Add cases proving that a short page does not end the scan while `paging.total` remains pending, and that cursor loops become inconclusive:

```js
test("short page continues while declared total is pending", () => {
  assert.deepEqual(Engine.nextPage({ rowsCount: 12, uniqueCount: 12, total: 90, offset: 0, returnedLimit: 50 }), {
    done: false, strategy: "offset", offset: 50,
  });
});

test("repeated cursor is inconclusive", () => {
  const result = Engine.nextPage({ rowsCount: 50, uniqueCount: 50, nextCursor: "same", seenCursors: new Set(["same"]) });
  assert.equal(result.done, true);
  assert.equal(result.coverage, "inconclusive");
  assert.equal(result.reason, "repeated_cursor");
});

test("duplicate-only page can advance to a later page", () => {
  const result = Engine.nextPage({ rowsCount: 50, uniqueCount: 0, total: 150, offset: 50, returnedLimit: 50 });
  assert.equal(result.done, false);
  assert.equal(result.offset, 100);
});
```

- [ ] **Step 5: Implement `nextPage` and coverage states**

Implement the decision without using requested page size as the sole end condition:

```js
function nextPage(input = {}) {
  const nextCursor = input.nextCursor == null ? null : String(input.nextCursor);
  if (nextCursor) {
    if (input.seenCursors?.has(nextCursor)) return { done: true, coverage: "inconclusive", reason: "repeated_cursor" };
    return { done: false, strategy: "cursor", cursor: nextCursor };
  }
  const total = Number.isFinite(Number(input.total)) ? Number(input.total) : null;
  const offset = Math.max(0, Number(input.offset || 0));
  const step = Math.max(1, Number(input.returnedLimit || input.rowsCount || 1));
  if (total != null && offset + Number(input.rowsCount || 0) < total) {
    return { done: false, strategy: "offset", offset: offset + step };
  }
  if (total != null) return { done: true, coverage: "complete", reason: "declared_total_reached" };
  if (Number(input.rowsCount || 0) === 0) return { done: true, coverage: "complete", reason: "empty_terminal_page" };
  return { done: true, coverage: "indeterminate", reason: "no_continuation_evidence" };
}
```

Export `nextPage` and define constants for `complete`, `partial`, `inconclusive`, and `indeterminate`.

- [ ] **Step 6: Run tests and commit**

Run: `node --test apps/seller-ml/tests/promo-smart-scan-engine.test.js`

Expected: all Task 1 tests PASS.

Commit:

```bash
git add apps/seller-ml/services/promoSmartScanEngine.js apps/seller-ml/tests/promo-smart-scan-engine.test.js
git commit -m "feat(ml): add SMART scan mode engine"
```

### Task 2: Add account-scoped checkpoint persistence

**Files:**
- Create: `apps/seller-ml/services/promoSmartCheckpointStore.js`
- Create: `apps/seller-ml/tests/promo-smart-checkpoint-store.test.js`

- [ ] **Step 1: Write failing store tests with an in-memory Redis fake**

Cover key scoping and expiry:

```js
test("checkpoint key isolates account, analysis, and campaign", () => {
  assert.equal(Store.key("acct-1", "analysis-1", "campaign-1"), "promo:smart-scan:acct-1:analysis-1:campaign-1");
});

test("save and load preserve cursor and coverage", async () => {
  const redis = fakeRedis();
  await Store.save(redis, { accountKey: "acct", analysisId: "a1", campaignId: "c1", ttlMs: 3600000 }, {
    strategy: "cursor", cursor: "next", pages: 3, coverage: "partial",
  });
  assert.deepEqual(await Store.load(redis, { accountKey: "acct", analysisId: "a1", campaignId: "c1" }), {
    strategy: "cursor", cursor: "next", pages: 3, coverage: "partial",
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test apps/seller-ml/tests/promo-smart-checkpoint-store.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the focused Redis adapter**

Use encoded path segments and JSON only:

```js
"use strict";
const DEFAULT_TTL_MS = Math.max(300000, Number(process.env.PROMO_SMART_CHECKPOINT_TTL_MS || 86400000));
const segment = (value) => encodeURIComponent(String(value || "unknown"));
const key = (accountKey, analysisId, campaignId) => `promo:smart-scan:${segment(accountKey)}:${segment(analysisId)}:${segment(campaignId)}`;

async function save(redis, scope, checkpoint) {
  if (!redis) return false;
  const ttl = Math.max(300000, Number(scope.ttlMs || DEFAULT_TTL_MS));
  await redis.set(key(scope.accountKey, scope.analysisId, scope.campaignId), JSON.stringify(checkpoint), "PX", ttl);
  return true;
}

async function load(redis, scope) {
  if (!redis) return null;
  const raw = await redis.get(key(scope.accountKey, scope.analysisId, scope.campaignId));
  return raw ? JSON.parse(raw) : null;
}

module.exports = { DEFAULT_TTL_MS, key, save, load };
```

Add `remove` and a manifest key listing campaign IDs for one analysis so expired/cancelled work can be enumerated without Redis `KEYS`.

- [ ] **Step 4: Run tests and commit**

Run: `node --test apps/seller-ml/tests/promo-smart-checkpoint-store.test.js`

Expected: PASS.

Commit:

```bash
git add apps/seller-ml/services/promoSmartCheckpointStore.js apps/seller-ml/tests/promo-smart-checkpoint-store.test.js
git commit -m "feat(ml): persist SMART scan checkpoints"
```

### Task 3: Integrate exhaustive collection and coverage into the analysis job

**Files:**
- Modify: `apps/seller-ml/services/promoSmartOptimizerService.js:18-26,300-529,1008-1112,1743-1798`
- Modify: `apps/seller-ml/tests/promo-smart-scan-engine.test.js`

- [ ] **Step 1: Add failing integration tests around injected ML pages**

Use the service `_test` export to verify:

```js
test("campaign source does not stop on duplicate-only page", async () => {
  const pages = [
    { results: [{ id: "A", type: "SMART" }], paging: { total: 3 } },
    { results: [{ id: "A", type: "SMART" }], paging: { total: 3 } },
    { results: [{ id: "B", type: "SMART" }], paging: { total: 3 } },
  ];
  const rows = await Service._test.collectCampaignSource({ fetchPage: async ({ page }) => pages[page], pageLimit: 1 });
  assert.deepEqual(rows.map((row) => row.id), ["A", "B"]);
});

test("item collector marks budget exhaustion partial", async () => {
  const result = await Service._test.collectCampaignItems({
    mode: "quick", policy: { maxPagesPerCampaign: 1 },
    fetchPage: async () => ({ results: [{ id: "MLB1" }], paging: { total: 2, limit: 1 } }),
  });
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.reason, "page_budget_reached");
});
```

- [ ] **Step 2: Run and verify the tests fail**

Run: `node --test apps/seller-ml/tests/promo-smart-scan-engine.test.js`

Expected: FAIL because the `_test` collectors are not exported.

- [ ] **Step 3: Replace premature stopping rules with the engine**

Import the new modules:

```js
const SmartScan = require("./promoSmartScanEngine");
const SmartCheckpoints = require("./promoSmartCheckpointStore");
```

Change campaign-source pagination so `added === 0` never ends a source by itself. Return discovery metadata alongside unique campaigns:

```js
return {
  campaigns: merged,
  coverage: { state, sources, expected: expectedTotal, collected: merged.length },
};
```

Change item pagination to return:

```js
return {
  rows: merged,
  coverage: {
    state: decision.coverage || "partial",
    reason: decision.reason || null,
    expected: total,
    collected: merged.length,
    pages,
    strategy,
  },
};
```

Persist a checkpoint after each accepted page and restore it when `resumeAnalysisId` is present. Do not store access tokens in checkpoints.

- [ ] **Step 4: Make `runAnalysisJob` mode-aware**

Read and normalize mode at job start:

```js
const mode = SmartScan.normalizeMode(job.data?.mode);
const resumeAnalysisId = String(job.data?.resumeAnalysisId || "").trim() || null;
```

Publish metadata fields `mode`, `coverageState`, `campaignsComplete`, `campaignsPartial`, `campaignsInconclusive`, `expectedRows`, and `collectedRows`. Run the final retry rounds only for incomplete campaigns and only up to the selected policy.

Pass only records from complete campaign pairs into `analyzeSmartRecords`. Build separate `inconclusive` entries for MLBs whose decision could depend on an incomplete campaign.

- [ ] **Step 5: Protect optimization at the service boundary**

Store `classification: "verified"` and `coverage_verified: true` on executable opportunities. Reject anything else before credit reservation:

```js
const opportunities = analysis.opportunities.filter((opp) =>
  ids.has(String(opp.id)) && opp.classification === "verified" && opp.coverage_verified === true
);
if (opportunities.length !== ids.size) {
  throw new Error("Uma ou mais oportunidades não possuem cobertura comprovada.");
}
```

- [ ] **Step 6: Run focused and billing regressions**

Run:

```bash
node --test apps/seller-ml/tests/promo-smart-scan-engine.test.js apps/seller-ml/tests/promo-smart-shadow-billing.test.js
```

Expected: PASS, with billing still absent from `startAnalysis`.

- [ ] **Step 7: Commit**

```bash
git add apps/seller-ml/services/promoSmartOptimizerService.js apps/seller-ml/tests/promo-smart-scan-engine.test.js
git commit -m "feat(ml): make SMART scans exhaustive and coverage-aware"
```

### Task 4: Add API mode validation, continuation, and progress contract

**Files:**
- Modify: `apps/seller-ml/routes/promocoesRoutes.js:4880-4943`
- Create: `apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

- [ ] **Step 1: Write failing contract tests**

Assert that the route reads `mode`, rejects unknown values, and passes `resume_analysis_id`:

```js
test("SMART analyze route validates quick/full mode", () => {
  assert.match(source, /const mode = String\(req\.body\?\.mode \|\| "quick"\)/);
  assert.match(source, /\["quick", "full"\]\.includes\(mode\)/);
});

test("SMART analyze route supports continuation", () => {
  assert.match(source, /resumeAnalysisId:\s*resumeAnalysisId/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

Expected: FAIL on missing mode contract.

- [ ] **Step 3: Implement request validation and response fields**

At the start of the handler:

```js
const mode = String(req.body?.mode || "quick").trim().toLowerCase();
if (!["quick", "full"].includes(mode)) {
  return res.status(400).json({ ok: false, error: "mode deve ser quick ou full." });
}
const resumeAnalysisId = String(req.body?.resume_analysis_id || "").trim() || null;
```

Pass both fields into `startAnalysis`, include `mode` in audit metadata, and return it in the `202` response. Extend `getAnalysis` to return the coverage counters already stored in job metadata.

- [ ] **Step 4: Add account-safe continuation validation**

Before enqueueing continuation, load the prior analysis through `getAnalysis(resumeAnalysisId, { accountKey })`. Return `404` for missing/foreign analyses and `409` if it is still active. Only `mode: "full"` may provide `resume_analysis_id`.

- [ ] **Step 5: Run tests and commit**

Run: `node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js apps/seller-ml/tests/promo-smart-shadow-billing.test.js`

Expected: PASS.

Commit:

```bash
git add apps/seller-ml/routes/promocoesRoutes.js apps/seller-ml/tests/promo-smart-intelligence-contract.test.js
git commit -m "feat(ml): expose SMART verification modes"
```

### Task 5: Build the two-mode interface and coverage presentation

**Files:**
- Modify: `apps/seller-ml/views/criar-promocao.html:571-637,718`
- Modify: `apps/seller-ml/public/js/promo-intelligence.js:4-255,350-410,500-565`
- Modify: `apps/seller-ml/public/css/promocoes.css:815-1009`
- Modify: `apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

- [ ] **Step 1: Add failing DOM/source contract tests**

Assert IDs and payload behavior:

```js
test("SMART UI exposes quick and full verification", () => {
  assert.match(html, /id="btnRunSmartQuickAnalysis"/);
  assert.match(html, /id="btnRunSmartFullAnalysis"/);
  assert.match(html, /id="smartOptimizerCoverage"/);
  assert.match(html, /data-smart-filter="inconclusive"/);
});

test("SMART UI sends selected mode and never selects inconclusive rows", () => {
  assert.match(script, /JSON\.stringify\(\{ mode/);
  assert.match(script, /classification === "verified"/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

Expected: FAIL because the new controls do not exist.

- [ ] **Step 3: Replace the single start button with mode cards**

Add accessible buttons and descriptions:

```html
<div class="smart-scan-modes" role="group" aria-label="Modo da verificação SMART">
  <button id="btnRunSmartQuickAnalysis" class="smart-scan-mode is-recommended" type="button">
    <strong>Verificação rápida</strong><span>Prioriza campanhas ativas e conflitos com maior potencial.</span>
  </button>
  <button id="btnRunSmartFullAnalysis" class="smart-scan-mode" type="button">
    <strong>Verificação completa</strong><span>Percorre todas as campanhas e pode levar vários minutos.</span>
  </button>
</div>
```

Add coverage counters, a third `inconclusive` filter, and `btnContinueSmartFull` hidden by default.

- [ ] **Step 4: Make browser state and requests mode-aware**

Add `mode: "quick"` to state and change the runner signature:

```js
async function runAnalysis(mode = "quick", resumeAnalysisId = null) {
  state.mode = mode === "full" ? "full" : "quick";
  const body = { mode: state.mode };
  if (resumeAnalysisId) body.resume_analysis_id = resumeAnalysisId;
  const data = await request("/api/promocoes/intelligence/smart/analyze", {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.analysisId = data.analysis_id;
}
```

Update progress with campaigns complete/total, collected/expected participations, retries, and textual coverage when a denominator is unknown.

- [ ] **Step 5: Render coverage and enforce unselectable inconclusive results**

Only initialize `state.selected` from:

```js
const selectable = (result.opportunities || []).filter(
  (row) => row.classification === "verified" && row.coverage_verified === true,
);
```

Render `result.inconclusive` without checkboxes. Show “Continuar como verificação completa” only when `result.mode === "quick"` and coverage is not complete.

- [ ] **Step 6: Add responsive CSS and bump asset versions**

Use a two-column mode grid on desktop and one column below the existing mobile breakpoint. Add distinct neutral, success, warning, and inconclusive states using existing promotion color variables. Increment `promocoes.css` and `promo-intelligence.js` query versions in the HTML.

- [ ] **Step 7: Run contract and syntax checks**

Run:

```bash
node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js
node --check apps/seller-ml/public/js/promo-intelligence.js
```

Expected: PASS and no syntax output.

- [ ] **Step 8: Commit**

```bash
git add apps/seller-ml/views/criar-promocao.html apps/seller-ml/public/js/promo-intelligence.js apps/seller-ml/public/css/promocoes.css apps/seller-ml/tests/promo-smart-intelligence-contract.test.js
git commit -m "feat(ml): add SMART scan mode and coverage UI"
```

### Task 6: Add coverage reporting, cancellation, and observability

**Files:**
- Modify: `apps/seller-ml/services/promoSmartOptimizerService.js:1640-1740,1861-1975`
- Modify: `apps/seller-ml/routes/promocoesRoutes.js:5100-5450`
- Modify: `apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

- [ ] **Step 1: Write failing report and job-contract tests**

Require analysis jobs to expose account-scoped status and XLSX coverage:

```js
test("analysis jobs expose mode and coverage without credentials", () => {
  assert.match(service, /coverage_state/);
  assert.match(service, /campaigns_complete/);
  assert.doesNotMatch(service, /checkpoint.*access_token/);
});

test("SMART workbook contains coverage sheet", () => {
  assert.match(service, /addWorksheet\("Cobertura"\)/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js`

Expected: FAIL on missing coverage report.

- [ ] **Step 3: Include analysis jobs in the shared jobs adapter**

Return analysis jobs from `listRecent` with title based on mode, lifecycle status, progress, cancellation capability, and no billing telemetry. Preserve the existing `smart:` ID namespace and account checks.

- [ ] **Step 4: Support cancellation between pages and campaigns**

Call the existing `checkCancelled(job)` before every page request and before every campaign. A cancelled analysis stores a partial result with `coverage.state = "partial"`, `coverage.reason = "cancelled"`, and no executable opportunities lacking complete evidence.

- [ ] **Step 5: Add a coverage worksheet**

Extend the SMART XLSX builder with:

```js
const coverageSheet = wb.addWorksheet("Cobertura");
coverageSheet.addRow(["Campanha", "Status", "Cobertura", "Esperado", "Coletado", "Páginas", "Motivo"]);
for (const row of analysis.coverage?.campaigns || []) {
  coverageSheet.addRow([row.name, row.status, row.state, row.expected, row.collected, row.pages, row.reason]);
}
coverageSheet.getRow(1).font = { bold: true };
coverageSheet.views = [{ state: "frozen", ySplit: 1 }];
```

- [ ] **Step 6: Add structured, secret-free audit metadata**

Audit mode, pages, retry counts, durations, coverage state, repeated cursors, and contradictory totals. Never include URLs containing tokens, authorization headers, or `mlCreds`.

- [ ] **Step 7: Run tests and commit**

Run: `node --test apps/seller-ml/tests/promo-smart-intelligence-contract.test.js apps/seller-ml/tests/promo-smart-shadow-billing.test.js`

Expected: PASS.

Commit:

```bash
git add apps/seller-ml/services/promoSmartOptimizerService.js apps/seller-ml/routes/promocoesRoutes.js apps/seller-ml/tests/promo-smart-intelligence-contract.test.js
git commit -m "feat(ml): report SMART scan coverage"
```

### Task 7: Wire the focused test command and run full verification

**Files:**
- Modify: `apps/seller-ml/package.json:5-35`

- [ ] **Step 1: Add the focused script**

Add without changing existing scripts:

```json
"test:promo-smart-intelligence": "node --test tests/promo-smart-scan-engine.test.js tests/promo-smart-checkpoint-store.test.js tests/promo-smart-intelligence-contract.test.js tests/promo-smart-shadow-billing.test.js"
```

- [ ] **Step 2: Run the focused suite**

Run: `npm --prefix apps/seller-ml run test:promo-smart-intelligence`

Expected: all SMART intelligence and billing tests PASS.

- [ ] **Step 3: Run syntax validation**

Run:

```bash
node --check apps/seller-ml/services/promoSmartScanEngine.js
node --check apps/seller-ml/services/promoSmartCheckpointStore.js
node --check apps/seller-ml/services/promoSmartOptimizerService.js
node --check apps/seller-ml/routes/promocoesRoutes.js
node --check apps/seller-ml/public/js/promo-intelligence.js
```

Expected: every command exits `0` without output.

- [ ] **Step 4: Run related regressions**

Run:

```bash
npm --prefix apps/seller-ml run test:stage2-tokens
npm --prefix apps/seller-ml run test:stage3-queues
npm --prefix apps/seller-ml run test:credits
npm --prefix apps/seller-ml run test:jobs-panel
```

Expected: all suites PASS. Any pre-existing unrelated failure must be recorded with its exact command and output rather than suppressed.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff --check
git status -sb
git diff --stat
```

Expected: no whitespace errors; only the files listed by this plan are modified, apart from pre-existing untracked user files.

- [ ] **Step 6: Commit verification wiring**

```bash
git add apps/seller-ml/package.json
git commit -m "test(ml): cover SMART scan modes"
```

## Manual acceptance checklist

- [ ] Start a quick scan on a test account and confirm the job remains usable while navigating away from the page.
- [ ] Confirm active campaigns are processed before pending campaigns.
- [ ] Confirm a partial quick result states that it is prioritized and does not claim total account coverage.
- [ ] Continue that result as a full scan and confirm valid checkpoints are reused.
- [ ] Confirm the full scan displays complete, partial, inconclusive, or indeterminate coverage without fabricating a percentage.
- [ ] Confirm inconclusive rows have no selection control and cannot be submitted by a crafted optimization request.
- [ ] Cancel an analysis and confirm its partial report remains visible but unsafe opportunities remain blocked.
- [ ] Download XLSX and inspect the `Cobertura` worksheet.
- [ ] Run an optimization from a verified opportunity and confirm pre-delete and post-delete revalidation still work.
- [ ] Confirm only successful removals settle credits.
