"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function remoteMethods(source) {
  return Array.from(source.matchAll(/method:\s*["']([A-Z]+)["']/g), (match) => match[1]);
}

test("Stage 3 Portfolio integration is remote read-only", () => {
  const service = read("apps/seller-magalu/src/services/portfolioReadService.js");
  const client = read("apps/seller-magalu/src/services/magaluApiClient.js");

  for (const endpoint of [
    "/seller/v1/portfolios/me",
    "/seller/v1/portfolios/skus",
    "/seller/v1/portfolios/prices",
    "/seller/v1/portfolios/stocks",
  ]) {
    assert.ok(service.includes(endpoint), endpoint);
  }
  assert.deepEqual(remoteMethods(service), ["GET"]);
  assert.match(client, /isRetryableMethod/);
  assert.match(client, /response\.status === 429/);
  assert.doesNotMatch(service, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
});

test("Stage 3 mirror remains isolated in magalu schema", () => {
  const migration = read("apps/seller-magalu/db/migrations/003_catalog_readonly.sql");
  for (const table of ["magalu.skus", "magalu.prices", "magalu.stocks"]) {
    assert.match(migration, new RegExp(`create table if not exists ${table.replace(".", "\\.")}`, "i"));
  }
  assert.match(migration, /foreign key \(account_id, sku\) references magalu\.skus\(account_id, sku\)/i);
  assert.match(migration, /add column if not exists catalog_sync_status/i);
  assert.doesNotMatch(migration, /\bml\./i);
  assert.doesNotMatch(migration, /\bshopee\b/i);
});

test("Stage 3 API exposes local catalog status/list/detail/sync/reconcile without write endpoints to Magalu", () => {
  const routes = read("apps/seller-magalu/src/routes/api.routes.js");
  for (const route of [
    '"/catalog/status"',
    '"/catalog/skus"',
    '"/catalog/skus/:sku"',
    '"/catalog/sync"',
    '"/catalog/skus/:sku/reconcile"',
    '"/catalog/runs"',
  ]) {
    assert.ok(routes.includes(route), route);
  }
  assert.match(routes, /remote_writes_enabled:/);
});

test("Stage 3 handles the documented Portfolio webhook topics", () => {
  const worker = read("apps/seller-magalu/src/jobs/webhookProcess.worker.js");
  const publicRoutes = read("apps/seller-magalu/src/routes/public.routes.js");
  for (const topic of ["portfolios_sku", "portfolios_price", "portfolios_stock"]) {
    assert.ok(worker.includes(`"${topic}"`), topic);
  }
  assert.match(publicRoutes, /express\.raw/);
  assert.match(publicRoutes, /\/webhooks\/v1/);
});

test("Stage 3 rate-limit defaults stay below current documented seller limits", () => {
  const env = read("apps/seller-magalu/src/config/env.js");
  assert.match(env, /MAGALU_RATE_LIMIT_SKU_READ_PER_MINUTE, 500/);
  assert.match(env, /MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE, 800/);
  assert.match(env, /MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE, 800/);
  const example = read("infra/env/seller-magalu.env.example");
  assert.match(example, /MAGALU_RATE_LIMIT_SKU_READ_PER_MINUTE=500/);
  assert.match(example, /MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE=800/);
  assert.match(example, /MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE=800/);
});

test("Stage 2 hardening is preserved in Stage 3", () => {
  const accountRepo = read("apps/seller-magalu/src/repositories/accountRepository.js");
  const oauth = read("apps/seller-magalu/src/controllers/oauthController.js");
  assert.match(accountRepo, /23505/);
  assert.match(accountRepo, /MAGALU_TENANT_ALREADY_LINKED/);
  const guard = oauth.indexOf("await revalidateCallbackAccess(req, stateRecord)");
  const exchange = oauth.indexOf("await finishAuthorization({ stateRecord, code })");
  assert.ok(guard >= 0 && exchange > guard);
});
