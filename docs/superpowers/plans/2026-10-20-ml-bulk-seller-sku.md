# Bulk SELLER_SKU Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Anúncios → Alteração de SKUs for the active ML account, with spreadsheet export/import, safe preview, durable background application and light/dark UI.

**Architecture:** Keep workbook parsing and row classification in a pure service; keep ML reads/writes and ownership checks in a separate service; persist a job and its rows before the worker applies anything. Routes use the existing account context and `ml.anuncios.cadastro` access policy. The UI reuses the Anúncios shell and polls the persisted job.

**Tech Stack:** Express/CommonJS, PostgreSQL, ExcelJS, existing Bull worker, HTML/CSS/vanilla JavaScript, Node test runner.

---

## File map

- `apps/seller-ml/services/bulkSkuWorkbookService.js`: XLSX export/import, string-preserving cells, CSV report escaping.
- `apps/seller-ml/services/bulkSkuPreviewService.js`: canonical row keys, names, EAN extraction, validation and classification.
- `apps/seller-ml/services/bulkSkuService.js`: active-account ML reads, preview creation, job ownership and application.
- `apps/seller-ml/services/bulkSkuQueueService.js`: Bull scheduling and worker lifecycle.
- `apps/seller-ml/controllers/BulkSkuController.js`, `apps/seller-ml/routes/bulkSkuRoutes.js`: HTTP boundary.
- `apps/seller-ml/db/075_create_bulk_sku_jobs.sql`: durable jobs and rows.
- `apps/seller-ml/views/alteracao-skus.html`, `apps/seller-ml/public/css/alteracao-skus.css`, `apps/seller-ml/public/js/alteracao-skus.js`: page.
- `apps/seller-ml/public/js/ml-shell.js`, `apps/seller-ml/app.js`, `apps/seller-ml/worker.js`: registration.
- `apps/seller-ml/tests/bulk-sku-*.test.js`: focused behavior and route tests.

## Task 1: Workbook and row contract

- [ ] Write `apps/seller-ml/tests/bulk-sku-workbook.test.js` first. Assert that `parseWorkbook(exportWorkbook(rows))` preserves `"07891234567890"`, unitary rows have empty variation ID and “Produto único”, and only `sku_novo` is read as a proposed change. Assert CSV values beginning `=`, `+`, `-` or `@` are prefixed with an apostrophe.

```js
const assert = require("node:assert/strict");
const { exportWorkbook, parseWorkbook, reportCsv } = require("../services/bulkSkuWorkbookService");
const rows = [{ conta: "Loja A", mlb: "MLB123456", id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "07891234567890", sku_atual: "OLD", sku_novo: "NEW" }];
assert.deepEqual(await parseWorkbook(await exportWorkbook(rows)), rows);
assert.match(reportCsv([{ sku_novo: "=SUM(1,1)" }]), /'=SUM/);
```
- [ ] Run `node --test apps/seller-ml/tests/bulk-sku-workbook.test.js` and confirm failure because the service does not exist.
- [ ] Implement `exportWorkbook(rows)`, `parseWorkbook(buffer)` and `reportCsv(rows)` in `bulkSkuWorkbookService.js` using ExcelJS. Use fixed headers `conta,mlb,id_variacao,nome_variacao,ean_gtin_atual,sku_atual,sku_novo`; set every identifier column to text. Reject unknown/missing headers and more than 5,000 rows; reject files above 10 MB at the upload middleware.

```js
const HEADERS = ["conta", "mlb", "id_variacao", "nome_variacao", "ean_gtin_atual", "sku_atual", "sku_novo"];
const safeCell = (value) => /^[=+\-@]/.test(String(value ?? "")) ? `'${value}` : String(value ?? "");
```
- [ ] Run the focused test, then commit only the service and test: `feat(ml): add bulk SKU workbook contract`.

## Task 2: Pure preview rules

- [ ] Write `apps/seller-ml/tests/bulk-sku-preview.test.js` first. Use rows for unitary and variation targets; assert `MLB123:` and `MLB123:987` remain distinct, duplicate targets are invalid, equal new/old SKUs are unchanged, wrong account/old SKU are divergent, changed EAN produces a warning, and blank/overlong new SKU is invalid.

```js
assert.equal(targetKey("MLB123", ""), "MLB123:");
assert.equal(targetKey("MLB123", "987"), "MLB123:987");
assert.equal(classifyRow({ sku_atual: "A", sku_novo: "A" }, { sku: "A" }, "Loja A").state, "unchanged");
```
- [ ] Run `node --test apps/seller-ml/tests/bulk-sku-preview.test.js` and confirm the expected failure.
- [ ] Implement `targetKey(mlb, variationId)`, `variationName(attributeCombinations)`, `gtinValues(attributes)` and `classifyRow(imported, live, activeAccount)` in `bulkSkuPreviewService.js`. Match `SELLER_SKU` from attributes before legacy `seller_custom_field`; extract GTIN/EAN values as strings without numeric conversion. Never classify EAN alone as the target identity.

```js
function targetKey(mlb, variationId) { return `${String(mlb).trim().toUpperCase()}:${String(variationId || "").trim()}`; }
function variationName(attrs) { return (attrs || []).map((row) => String(row.value_name || row.value_id || "").trim()).filter(Boolean).join(" / ") || "Produto único"; }
```
- [ ] Run the focused test and commit: `feat(ml): classify bulk SKU changes safely`.

## Task 3: Persistence and account-scoped HTTP boundary

- [ ] Write `apps/seller-ml/tests/bulk-sku-routes.test.js` first. Assert export/preview/jobs/download reject requests without account access, confirmation rejects edit-disabled access, and a workbook row naming another account cannot change the active account.
- [ ] Run `node --test apps/seller-ml/tests/bulk-sku-routes.test.js` and confirm failure for missing route/service.
- [ ] Add migration `075_create_bulk_sku_jobs.sql` with `ml.bulk_sku_jobs` (`id`, `account_key`, `requested_by`, `status`, counts, timestamps) and `ml.bulk_sku_job_rows` (`job_id`, `mlb`, `variation_id`, old/new SKU, EAN snapshot, state, response, timestamps), a unique index on `(job_id, mlb, variation_id)`, and account/job lookup indexes. Follow existing `ml` migration conventions and tenant ownership checks.

```sql
CREATE TABLE ml.bulk_sku_jobs (id text PRIMARY KEY, account_key text NOT NULL, requested_by text NOT NULL, status text NOT NULL, total_rows integer NOT NULL DEFAULT 0, processed_rows integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE TABLE ml.bulk_sku_job_rows (job_id text NOT NULL REFERENCES ml.bulk_sku_jobs(id), mlb text NOT NULL, variation_id text NOT NULL DEFAULT '', old_sku text NOT NULL, new_sku text NOT NULL, ean_snapshot text NOT NULL DEFAULT '', state text NOT NULL, response jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (job_id, mlb, variation_id));
CREATE INDEX bulk_sku_jobs_account_created_idx ON ml.bulk_sku_jobs(account_key, created_at DESC);
```
- [ ] Implement routes under `/api/bulk-sku`: `GET /export.xlsx`, `POST /preview` (Multer memory upload), `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/report.csv`. Register in `app.js`. Apply `companyAccess.requireModuleAccess("ml.anuncios.cadastro", { defaultAllowIfUnconfigured: true })` for reading and the same with `{ edit: true, defaultAllowIfUnconfigured: true }` for confirmation. Derive account from authenticated request context, never from sheet cells.

```js
const access = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { defaultAllowIfUnconfigured: true });
const editAccess = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { edit: true, defaultAllowIfUnconfigured: true });
router.use(access);
router.get("/export.xlsx", Controller.exportWorkbook);
router.post("/preview", upload.single("file"), Controller.preview);
router.post("/jobs", editAccess, Controller.createJob);
router.get("/jobs/:id", Controller.getJob);
router.get("/jobs/:id/report.csv", Controller.report);
```
- [ ] Run focused route/migration tests and commit: `feat(ml): persist account-scoped bulk SKU jobs`.

## Task 4: ML application and queue

- [ ] Write `apps/seller-ml/tests/bulk-sku-apply.test.js` first. Assert a stale `SELLER_SKU` blocks the row, the `PUT /items/{mlb}` includes only intended attributes, untouched variation IDs remain in a variation payload, verified rows are not sent twice, a 429/5xx is retried a bounded number of times, a permanent 4xx stays on that row, and costs/GTIN/`seller_custom_field` are never written.
- [ ] Run `node --test apps/seller-ml/tests/bulk-sku-apply.test.js` and confirm failure before implementation.
- [ ] Implement `applyJobRow` and `applyJob` in `bulkSkuService.js` using the active account's stored ML credentials at execution time. Re-read the item, compare the preview snapshot, PUT only the `SELLER_SKU` attribute at item/variation scope, then GET to confirm. Group multiple changes for one MLB, preserve all variation IDs in the outgoing array, persist per-row results and use idempotent state transitions.

```js
const current = await ml.get(`/items/${mlb}`, { accessToken });
if (readSellerSku(current, variationId) !== expectedSku) return markRow("stale");
const body = variationId
  ? { variations: current.variations.map((v) => ({ id: v.id, ...(String(v.id) === variationId ? { attributes: replaceSku(v.attributes, newSku) } : {}) })) }
  : { attributes: replaceSku(current.attributes, newSku) };
await ml.request(`/items/${mlb}`, { accessToken, method: "PUT", body });
if (readSellerSku(await ml.get(`/items/${mlb}`, { accessToken }), variationId) !== newSku) return markRow("unverified");
return markRow("applied");
```
- [ ] Implement `enqueueBulkSkuJob`/`initWorker` in `bulkSkuQueueService.js` following `estoqueAtualizacaoQueueService.js`; initialize in `worker.js`. Limit throughput and retry only transient responses. Do not reserve or charge new credits. Trigger existing SKU catalog sync after verified success without migrating cost/reference overrides.
- [ ] Run apply tests and the existing SKU/stock queue tests; commit: `feat(ml): process verified SKU changes in background`.

## Task 5: Anúncios page and themes

- [ ] Write `apps/seller-ml/tests/bulk-sku-page.test.js` first. Assert the Anúncios nav contains “Alteração de SKUs” after Cadastro, the page labels include active account/variation name/EAN/SKU columns, and the page has export, upload, preview, confirm, progress and report controls.
- [ ] Run `node --test apps/seller-ml/tests/bulk-sku-page.test.js` and confirm failure.
- [ ] Add `alteracao-skus.html` with the existing `ml-app.css`, `anuncios.css`, brand theme stylesheet and shell. Implement the four step states in `alteracao-skus.js`; poll the job endpoint and show per-row errors. Add scoped `alteracao-skus.css` using the existing `--ads-*` tokens and `body.theme-dark.ads-app` selectors. Do not change existing Anúncios page layouts.

```html
<main class="ads-page sku-bulk-page"><header class="ads-page-header"><div><span class="ads-kicker">Anúncios</span><h1>Alteração de SKUs</h1><p id="activeAccountName"></p></div></header><nav aria-label="Etapas"><span>Exportar</span><span>Preencher</span><span>Revisar</span><span>Aplicar</span></nav><section id="bulkSkuWorkspace" aria-live="polite"></section></main>
```
- [ ] Register page route and `ml-shell.js` nav item. Check keyboard focus, table overflow, loading/empty/error states, mobile width and both themes. Run focused tests and commit: `feat(ml): add themed bulk SKU page`.

## Task 6: End-to-end verification

- [ ] Run all focused tests: `node --test apps/seller-ml/tests/bulk-sku-*.test.js` from repository root; expect zero failures.
- [ ] Run `npm --prefix apps/seller-ml run test:anuncio-cadastro`, stock update tests, and `git diff --check`; expect zero failures.
- [ ] Validate the migration against a disposable test database; verify repeated execution is skipped by the migration runner.
- [ ] Manually exercise one unitary and one variation item in a test ML account; inspect the GET response after PUT, verify unchanged EAN/other variations and unchanged cost records. Do not apply a bulk production lot without a separate user confirmation.
- [ ] Capture responsive light/dark screenshots and correct clipping/contrast before completion. Report test evidence, migration status and any unverified external behavior plainly.
