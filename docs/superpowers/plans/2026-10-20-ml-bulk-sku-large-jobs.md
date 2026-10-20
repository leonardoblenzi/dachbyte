# Large Bulk SKU Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export all account SKUs by status and apply more than 5,000 changes from one workbook through visible background jobs.

**Architecture:** Reuse Bull and the existing shared results volume. Persist export and preview job state in Postgres; stream XLSX files; fetch ML items and apply changes in bounded groups; expose account-scoped polling, paginated preview, and downloads.

**Tech Stack:** Node.js, Express, Bull, PostgreSQL, ExcelJS, shared JobsPanel.

---

### Task 1: Persistent export jobs

**Files:** `apps/seller-ml/db/076_bulk_sku_large_jobs.sql`, `apps/seller-ml/services/bulkSkuExportService.js`, `apps/seller-ml/tests/bulk-sku-export.test.js`.

- [ ] Write tests for validated statuses, 5,100 items, account-scoped download, and stream cleanup.
- [ ] Run `node --test tests/bulk-sku-export.test.js` and verify expected failures.
- [ ] Add migration and export service: create job, scan by status, write XLSX incrementally, persist progress and safe file name.
- [ ] Run focused tests and verify zero failures.

### Task 2: Asynchronous large preview

**Files:** `apps/seller-ml/services/bulkSkuPreviewJobService.js`, `apps/seller-ml/services/bulkSkuWorkbookService.js`, `apps/seller-ml/services/bulkSkuService.js`, `apps/seller-ml/tests/bulk-sku-large-preview.test.js`.

- [ ] Write tests for more than 5,000 rows, chunked ML reads, no cross-account access, and paginated preview.
- [ ] Run the focused test and verify expected failures.
- [ ] Process the upload in the worker, store row decisions, and return a paginated preview rather than the entire workbook in one response.
- [ ] Run focused tests and verify zero failures.

### Task 3: Routes, worker and UI

**Files:** `apps/seller-ml/routes/bulkSkuRoutes.js`, `apps/seller-ml/controllers/BulkSkuController.js`, `apps/seller-ml/services/bulkSkuQueueService.js`, `apps/seller-ml/worker.js`, `apps/seller-ml/views/alteracao-skus.html`, `apps/seller-ml/public/js/alteracao-skus.js`, `apps/seller-ml/tests/bulk-sku-page.test.js`.

- [ ] Write tests for filters, start/status/download endpoints and shared JobsPanel wiring.
- [ ] Run focused tests and verify expected failures.
- [ ] Add endpoints, worker processors, status filters and job panel updates for export, preview and application.
- [ ] Run focused and full `node --test tests/*.test.js`; verify zero failures, then commit only relevant files.
