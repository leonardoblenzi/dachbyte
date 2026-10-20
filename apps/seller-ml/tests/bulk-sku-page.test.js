"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("SKU page is reachable from Ads and exposes the bulk workflow", () => {
  const root = path.join(__dirname, "..");
  const routes = fs.readFileSync(path.join(root, "routes/htmlRoutes.js"), "utf8");
  const shell = fs.readFileSync(path.join(root, "public/js/ml-shell.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "views/alteracao-skus.html"), "utf8");
  assert.match(routes, /"\/anuncios\/alteracao-skus"/);
  assert.match(shell, /label: "Alteração de SKUs", path: "\/anuncios\/alteracao-skus"/);
  for (const id of ["downloadTemplate", "skuFile", "previewButton", "previewRows", "confirmButton", "jobStatus", "downloadReport"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="accountLabel"|id="sku-account-title"|class="sku-account-badge"/);
  assert.match(html, /anuncios\.css/);
  assert.match(html, /alteracao-skus\.css/);
  assert.match(html, /alteracao-skus\.js/);
  assert.match(html, /id="bulkJobsPanel"/);
  assert.match(html, /jobs-panel\.js/);
  assert.match(html, /id="exportStatus"/);
});

test("page requests active-account context and only confirms a preview", () => {
  const root = path.join(__dirname, "..");
  const js = fs.readFileSync(path.join(root, "public/js/alteracao-skus.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "routes/bulkSkuRoutes.js"), "utf8");
  assert.match(routes, /router\.get\("\/context", Controller\.getContext\)/);
  assert.match(js, /api\("\/context"\)/);
  assert.match(js, /\/api\/bulk-sku\/preview/);
  assert.match(js, /\/api\/bulk-sku\/jobs/);
  assert.match(js, /JobsPanel\?\.mergeApiJobs/);
  assert.doesNotMatch(js, /accountKey\s*:/);
});
