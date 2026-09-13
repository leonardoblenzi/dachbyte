"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("dashboard round 2 keeps the Core dashboard generic and management-oriented", () => {
  const dashboard = source("src/modules/core/runtime/services/dashboardService.js");
  assert.match(dashboard, /Vendas hoje/);
  assert.match(dashboard, /Recebido hoje/);
  assert.match(dashboard, /A receber/);
  assert.match(dashboard, /Vencido/);
  assert.match(dashboard, /physical/);
  assert.match(dashboard, /reserved/);
  assert.match(dashboard, /available/);
  assert.match(dashboard, /salesTrend/);
  assert.match(dashboard, /dashboard\.contribute/);
  assert.doesNotMatch(dashboard, /optical_orders|vertical\.optical|pedido optico/i);
});

test("dashboard round 2 aggregates urgent attention instead of returning long item lists", () => {
  const dashboard = source("src/modules/core/runtime/services/dashboardService.js");
  assert.match(dashboard, /receivables-overdue/);
  assert.match(dashboard, /expenses-overdue/);
  assert.match(dashboard, /stock-critical/);
  assert.match(dashboard, /slice\(0, 5\)/);
  assert.match(dashboard, /intent:\s*\{ tab: "pending", filter: "Vencidos" \}/);
});

test("optical extension contributes its own compact order widget and alerts", () => {
  const optical = source("src/extensions/optical/backend/entityHooks.js");
  assert.match(optical, /widgets:\s*\[/);
  assert.match(optical, /title: "Pedidos"/);
  assert.match(optical, /Em producao/);
  assert.match(optical, /Prontos para retirada/);
  assert.match(optical, /Atrasados/);
  assert.match(optical, /Concluidos hoje/);
  assert.match(optical, /filter: "Entrega atrasada"/);
});

test("dashboard payload is pruned per permission before reaching the browser", () => {
  const controller = source("src/controllers/RuntimeController.js");
  assert.match(controller, /function pruneDashboardForAccess/);
  assert.match(controller, /metrics: \(dashboard\.metrics \|\| \[\]\)\.filter/);
  assert.match(controller, /operationWidgets: \(dashboard\.operationWidgets \|\| \[\]\)\.filter/);
  assert.match(controller, /finance: dashboard\.finance && can\(dashboard\.finance\.permission\)/);
  assert.match(controller, /inventory: dashboard\.inventory && can\(dashboard\.inventory\.permission\)/);
  assert.match(controller, /salesTrend: can\(dashboard\.salesTrendPermission\)/);
});

test("dashboard UI preserves quick actions while keeping the panel compact", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /Acoes rapidas/);
  assert.match(main, /Nova venda/);
  assert.match(main, /Novo cliente/);
  assert.match(main, /Receber produtos/);
  assert.match(main, /primaryOperation/);
  assert.match(main, /Precisa de atencao/);
  assert.match(main, /function DashboardFinanceWidget/);
  assert.match(main, /function DashboardInventorySummary/);
  assert.match(main, /function DashboardSalesTrend/);
  assert.doesNotMatch(main.slice(main.indexOf("function DashboardPage"), main.indexOf("function SalesPage")), /Atividade recente/);
});

test("dashboard navigation can open target tabs with filters", () => {
  const main = source("src/client/main.jsx");
  const list = source("src/client/components/OperationalList.jsx");
  const queries = source("src/modules/core/runtime/services/dataQueryService.js");
  assert.match(main, /function navigateWithIntent/);
  assert.match(main, /navigationIntent\?\.tab/);
  assert.match(main, /initialFilter=\{navigationIntent\?\.filter\}/);
  assert.match(main, /"Entrega atrasada"/);
  assert.match(main, /"Concluido hoje"/);
  assert.match(queries, /concluido hoje/);
  assert.match(list, /initialFilter/);
  assert.match(queries, /entrega atrasada/);
});
