"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Stage 4 adds isolated protected write queues and never imports ML/Shopee business code", () => {
  const names = read("apps/seller-magalu/src/config/queueNames.js");
  assert.match(names, /magalu-price-update/);
  assert.match(names, /magalu-stock-update/);
  for (const file of [
    "apps/seller-magalu/src/services/portfolioWriteService.js",
    "apps/seller-magalu/src/services/writeExecutionService.js",
    "apps/seller-magalu/src/controllers/writeController.js",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /seller-ml|seller-shopee|\bml\./i, file);
  }
});

test("Stage 4 exposes only price/stock writes behind preview and explicit apply", () => {
  const routes = read("apps/seller-magalu/src/routes/api.routes.js");
  assert.match(routes, /\/writes\/preview/);
  assert.match(routes, /\/writes\/apply/);
  assert.match(routes, /protected_writes:true/);
  const writer = read("apps/seller-magalu/src/services/portfolioWriteService.js");
  assert.match(writer, /method = exists \? "PATCH" : "POST"/);
  assert.match(writer, /attempts: 1/);
  assert.doesNotMatch(writer, /\/skus\//);
});

test("write execution re-reads remote state and never resends after remote acceptance", () => {
  const source = read("apps/seller-magalu/src/services/writeExecutionService.js");
  assert.match(source, /MAGALU_REMOTE_STATE_CHANGED/);
  assert.match(source, /dispatching/);
  assert.match(source, /verifyAcceptedWrite/);
  assert.match(source, /MAGALU_WRITE_NOT_CONVERGED/);
  assert.match(source, /MAGALU_WRITE_RESULT_UNCERTAIN/);
  assert.match(source, /isReconciliationOnly\(operation\)/);
  assert.ok(
    source.indexOf("if (isReconciliationOnly(operation))") < source.indexOf("if (!env.MAGALU_WRITE_ENABLED)"),
    "reconciliation must happen before write flag/scope gates",
  );
});

test("worker performs a fresh Hub WRITE magalu check immediately before dispatch", () => {
  const source = read("apps/seller-magalu/src/services/writeExecutionService.js");
  assert.match(source, /force: true, action: "WRITE magalu"/);
  assert.match(source, /MAGALU_WRITE_HUB_ACCESS_DENIED/);
  assert.ok(
    source.indexOf("await assertFreshHubWriteAccess(operation)") < source.indexOf("setOperationDispatching"),
    "Hub check must precede dispatching",
  );
});

test("apply and manual reverify require a fresh Hub WRITE magalu check", () => {
  const source = read("apps/seller-magalu/src/controllers/writeController.js");
  assert.match(source, /force: true, action: "WRITE magalu"/);
  assert.match(source, /Reverificação é somente leitura/);
});

test("write workers accept apply and verify and write jobs retry safely", () => {
  for (const file of [
    "apps/seller-magalu/src/jobs/priceUpdate.worker.js",
    "apps/seller-magalu/src/jobs/stockUpdate.worker.js",
  ]) {
    const source = read(file);
    assert.match(source, /\["apply", "verify"\]/, file);
    assert.match(source, /executeOperation\(job\.data\.operationId\)/, file);
  }
  const queue = read("apps/seller-magalu/src/queues/magaluQueue.js");
  assert.match(queue, /jobName = reason === "reverify" \? "verify" : "apply"/);
  assert.match(queue, /attempts: 3/);
  assert.match(queue, /backoff: \{ type: "exponential", delay: 5000 \}/);
});

test("Stage 4 migration persists one-time previews, operations and audit", () => {
  const sql = read("apps/seller-magalu/db/migrations/004_protected_price_stock_writes.sql").toLowerCase();
  for (const table of ["magalu.write_previews", "magalu.write_operations", "magalu.audit_events"]) {
    assert.ok(sql.includes(`create table if not exists ${table}`), table);
  }
  assert.match(sql, /uq_magalu_write_active_resource/);
  assert.match(sql, /dispatching/);
  assert.match(sql, /uncertain/);
  assert.doesNotMatch(sql, /\bml\./i);
});

test("write scopes are opt-in and write mode defaults disabled in VPS example", () => {
  const env = read("infra/env/seller-magalu.env.example");
  assert.match(env, /^MAGALU_WRITE_ENABLED=false$/m);
  assert.match(env, /open:portfolio-prices-seller:write/);
  assert.match(env, /open:portfolio-stocks-seller:write/);
  assert.match(env, /MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE=800/);
  assert.match(env, /MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE=600/);
});
