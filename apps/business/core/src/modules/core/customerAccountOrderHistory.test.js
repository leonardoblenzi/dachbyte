"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("customer account is a Core read model with purchases, received cash, open balance and overdue debt", () => {
  const service = source("src/modules/core/runtime/services/customerAccountService.js");
  assert.match(service, /totalPurchased/);
  assert.match(service, /totalReceived/);
  assert.match(service, /openBalance/);
  assert.match(service, /overdueBalance/);
  assert.match(service, /pendingDeliveryBalance/);
  assert.match(service, /cash_movements/);
  assert.match(service, /receivables/);
  assert.match(service, /timeline/);
  assert.doesNotMatch(service, /optical_orders|vertical\.optical/i);
});

test("complete order history composes generic Core audit, workflow, stock and finance events", () => {
  const service = source("src/modules/core/runtime/services/saleHistoryService.js");
  assert.match(service, /workflow_events/);
  assert.match(service, /metadata->>'saleId'/);
  assert.match(service, /stock_reservations/);
  assert.match(service, /inventory_movements/);
  assert.match(service, /cash_movements/);
  assert.match(service, /receivables/);
  assert.match(service, /audit_logs/);
  assert.match(service, /receipts/);
  assert.doesNotMatch(service, /optical_orders|opticalService|vertical\.optical/i);
});

test("customer account and order history use base access plus permission-aware partial payloads", () => {
  const routes = source("src/routes/core.routes.js");
  const controller = source("src/controllers/RuntimeController.js");
  assert.match(routes, /customers\/:customerId\/account", requireRuntimePermission\("customers:read"\), asyncHandler\(RuntimeController\.getCustomerAccount\)/);
  assert.match(routes, /sales\/:saleId\/history", requireRuntimePermission\("sales:read"\), asyncHandler\(RuntimeController\.getSaleHistory\)/);
  assert.match(controller, /resolveOptionalPermissionAccess/);
  assert.match(controller, /sales: "sales:read"/);
  assert.match(controller, /receivables: "receivables:read"/);
  assert.match(controller, /cashRegister: "cash_register:read"/);
  assert.match(controller, /receipts: "receipts:read"/);
  assert.match(controller, /inventory: "inventory:read"/);
  assert.match(controller, /audit: "audit:read"/);
});

test("receivable settlement now writes an audit event that can feed history", () => {
  const finance = source("src/modules/core/runtime/services/financeService.js");
  assert.match(finance, /"receivable\.received"/);
  assert.match(finance, /insertAuditWithClient/);
  assert.match(finance, /paymentMethod/);
  assert.match(finance, /saleId: row\.saleId/);
});

test("customer UI exposes Financeiro with the Conta corrente view, receive actions and a consolidated timeline", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /label: "Financeiro"/);
  assert.match(main, /function CustomerFinance/);
  assert.match(main, /Conta corrente/);
  assert.match(main, /Total recebido/);
  assert.match(main, /Movimentacao da conta/);
  assert.match(main, /onAction\("receivableReceive"/);
  assert.match(main, /volt:action-completed/);
});

test("order detail UI includes complete history timeline", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /Detalhes e historico/);
  assert.match(main, /Historico completo do pedido/);
  assert.match(main, /function OrderHistoryTimeline/);
  assert.match(main, /\/sales\/\$\{sale\.recordId\}\/history/);
});

test("round 4 adds read-path indexes without rewriting business data", () => {
  const migration = source("db/020_customer_account_order_history_indexes.sql");
  assert.match(migration, /cash_movements.*company_source/s);
  assert.match(migration, /receivables.*company_sale/s);
  assert.match(migration, /audit_logs.*sale_metadata/s);
  assert.match(migration, /workflow_events.*sale_metadata/s);
  assert.doesNotMatch(migration, /\b(update|delete|insert into)\b/i);
});

test("legacy payment method tables receive the metadata column required by runtime lookups", () => {
  const migration = source("db/021_payment_methods_metadata.sql");
  assert.match(migration, /alter table volt_core\.payment_methods/i);
  assert.match(migration, /add column if not exists metadata jsonb/i);
  assert.match(migration, /default '\{\}'::jsonb/i);
});
