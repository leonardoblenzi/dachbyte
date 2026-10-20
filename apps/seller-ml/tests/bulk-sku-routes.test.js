"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("bulk SKU endpoints gate writes and resolve the active account server-side", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/bulkSkuRoutes.js"), "utf8");
  const controller = fs.readFileSync(path.join(__dirname, "../controllers/BulkSkuController.js"), "utf8");
  assert.match(routes, /requireModuleAccess\("ml\.anuncios\.cadastro", \{ edit: true/);
  assert.match(routes, /router\.post\("\/jobs", editAccess/);
  assert.match(controller, /res\.locals\?\.accountKey/);
  assert.doesNotMatch(controller, /req\.body\?\.accountKey/);
  const app = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  assert.match(app, /safeUse\("bulkSkuRoutes", "\.\/routes\/bulkSkuRoutes", "\/api\/bulk-sku"\)/);
  assert.match(routes, /router\.post\("\/exports", editAccess/);
  assert.match(routes, /router\.get\("\/exports\/:id\/download.xlsx"/);
  assert.match(routes, /router\.get\("\/jobs"/);
  assert.match(routes, /LIMIT_FILE_SIZE/);
  assert.match(routes, /100 \* 1024 \* 1024/);
});

test("persistent jobs are scoped to account and preserve row identity", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/075_create_bulk_sku_jobs.sql"), "utf8");
  assert.match(sql, /account_key text NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(job_id, row_number\)/i);
  assert.match(sql, /new_sku text NOT NULL/i);
});
