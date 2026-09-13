"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("delivery completion preserves the original sold_at and uses a separate operational timestamp", () => {
  const sales = source("src/modules/core/runtime/services/salesService.js");
  const block = sales.slice(sales.indexOf("async function completeSaleDelivery"), sales.indexOf("async function updateSale"));
  assert.match(block, /const deliveryAt = new Date\(\)\.toISOString\(\)/);
  assert.match(block, /set status = 'finalized', payments = \$3::jsonb, delivered_at = \$4, updated_at = now\(\)/);
  assert.doesNotMatch(block, /sold_at\s*=\s*\$4/);
  assert.match(block, /normalizeSalePayments\(payments, toMoney\(sale\.total\), deliveryAt\)/);
  assert.match(block, /createSaleFinancialRecords[\s\S]*deliveryAt/);
});

test("Core sales services no longer query optical_orders directly", () => {
  const sales = source("src/modules/core/runtime/services/salesService.js");
  const queries = source("src/modules/core/runtime/services/dataQueryService.js");
  const opticalHooks = source("src/extensions/optical/backend/saleHooks.js");
  const manifest = source("src/extensions/optical/manifest.js");
  assert.doesNotMatch(sales, /volt_core\.optical_orders/);
  assert.doesNotMatch(queries, /volt_core\.optical_orders/);
  assert.match(sales, /sale\.beforeUpdated/);
  assert.match(queries, /sale\.decorateRows/);
  assert.match(queries, /sale\.resolveListFilter/);
  assert.match(opticalHooks, /async function beforeSaleUpdated/);
  assert.match(opticalHooks, /async function decorateSaleRows/);
  assert.match(opticalHooks, /async function resolveSaleListFilter/);
  assert.match(manifest, /"sale\.beforeUpdated"/);
  assert.match(manifest, /"sale\.decorateRows"/);
  assert.match(manifest, /"sale\.resolveListFilter"/);
});

test("customer account gives canceled sales precedence over delivery timing and loads receipts by customer", () => {
  const account = source("src/modules/core/runtime/services/customerAccountService.js");
  assert.match(account, /sale\.status === "canceled"[\s\S]*sale\.paymentTiming === "delivery"/);
  assert.match(account, /from volt_core\.receipts r[\s\S]*s\.customer_id=\$2/);
  assert.match(account, /pendingDeliveryCount/);
  assert.match(account, /max\(sold_at\).*"lastPurchaseAt"/);
  assert.match(account, /order by s\.sold_at desc,s\.created_at desc/);
  assert.match(account, /access:\s*\{/);
});

test("order history prunes optional financial, inventory, receipt and audit data instead of blocking the whole endpoint", () => {
  const history = source("src/modules/core/runtime/services/saleHistoryService.js");
  assert.match(history, /historyAccessAllowed/);
  assert.match(history, /canInventory \? db\.query/);
  assert.match(history, /canReceivables \? db\.query/);
  assert.match(history, /canReceipts \? db\.query/);
  assert.match(history, /canCash \? db\.query/);
  assert.match(history, /canAudit \? db\.query/);
  assert.match(history, /access:\s*\{/);
});

test("customer UI uses account-scoped receipts and explains partial permission views", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /const receipts = account \? \(account\.receipts \|\| \[\]\) : fallbackReceipts/);
  assert.match(main, /Visao parcial: alguns dados foram ocultados/);
  assert.match(main, /Historico parcial: eventos restritos pelas permissoes/);
  assert.match(main, /pendingDeliveryCount/);
});
