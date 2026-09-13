"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizePageQuery, normalizeDateKey } = require("./runtime/services/paging");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relativePath), "utf8");
}

test("workspace v2 normalizes paging and rejects impossible date filters", () => {
  assert.deepEqual(normalizePageQuery({ page: 2, pageSize: 500, search: "  Jonas  ", dateFrom: "2026-08-01" }), {
    page: 2,
    pageSize: 100,
    offset: 100,
    search: "Jonas",
    filter: "",
    dateFrom: "2026-08-01",
    dateTo: "",
    scope: "",
  });
  assert.equal(normalizeDateKey("2026-02-31"), "");
  assert.equal(normalizeDateKey("2028-02-29"), "2028-02-29");
});

test("workspace v2 bootstrap no longer loads operational collections", () => {
  const platform = source("modules/core/runtime/services/platformService.js");
  const getWorkspace = platform.slice(platform.indexOf("async function getWorkspace"), platform.indexOf("async function createCompany"));
  assert.match(getWorkspace, /workspaceVersion:\s*2/);
  assert.match(getWorkspace, /getDashboard\(companyId, configuration\)/);
  assert.doesNotMatch(getWorkspace, /listCustomers|listProducts|listSales|listReceivables|listExpenses|listInventoryMovements/);
  assert.match(getWorkspace, /where c\.id=\$1/);
  assert.doesNotMatch(getWorkspace, /listCompanies\(\)/);
});

test("workspace v2 exposes permission-protected paged data and server reports", () => {
  const routes = source("routes/core.routes.js");
  assert.match(routes, /data\/customers"\s*,\s*requireRuntimePermission\("customers:read"\)/);
  assert.match(routes, /data\/sales"\s*,\s*requireRuntimePermission\("sales:read"\)/);
  assert.match(routes, /data\/audit-logs"\s*,\s*requireRuntimePermission\("audit:read"\)/);
  assert.match(routes, /reports\/summary"\s*,\s*requireRuntimePermission\("reports:read"\)/);
});

test("workspace mapper patches only collections returned by lazy endpoints", () => {
  const mapper = source("client/workspace/mapWorkspaceToAppData.js");
  assert.match(mapper, /function hasWorkspaceField\(workspace, key\)/);
  assert.match(mapper, /if \(hasWorkspaceField\(workspace, "customers"\)\) next\.customers/);
  assert.match(mapper, /if \(hasWorkspaceField\(workspace, "products"\)\) next\.products/);
  assert.match(mapper, /if \(hasWorkspaceField\(workspace, "cashSummary"\)\) next\.cashSummary/);
});

test("server-side reports aggregate totals in postgres instead of browser subsets", () => {
  const reports = source("modules/core/runtime/services/reportService.js");
  assert.match(reports, /coalesce\(sum\(s\.total\),0\)/i);
  assert.match(reports, /coalesce\(sum\(e\.remaining_amount\),0\)/i);
  assert.match(reports, /coalesce\(sum\(case when r\.status/i);
  assert.match(reports, /lowStockCount/);
  const main = source("client/main.jsx");
  assert.match(main, /normalizeServerReports/);
  assert.match(main, /fetchRuntimeReports/);
});

test("server-side operational overviews keep exact totals while tables are paged", () => {
  const queries = source("modules/core/runtime/services/dataQueryService.js");
  assert.match(queries, /openCount/);
  assert.match(queries, /paidCount/);
  assert.match(queries, /openedCount/);
  assert.match(queries, /producingCount/);
  assert.match(queries, /queueRows/);
  assert.match(queries, /limit \$\d+ offset \$\d+/i);
});

test("workspace v2 migration adds indexes for high-volume read paths", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "015_workspace_v2_indexes.sql"), "utf8");
  assert.match(migration, /customers \(company_id, active, number\)/i);
  assert.match(migration, /sales \(company_id, status, sold_at desc/i);
  assert.match(migration, /cash_movements \(company_id, session_id, operational_at desc/i);
  assert.match(migration, /service_orders \(company_id, due_date, status\)/i);
});


test("workspace v2 inventory operational dates exist before the read-path index", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "014_inventory_operational_dates.sql"), "utf8");
  assert.match(migration, /alter table volt_core\.inventory_movements[\s\S]*add column if not exists operational_at timestamptz/i);
  assert.match(migration, /set operational_at = created_at/i);
  assert.match(migration, /alter column operational_at set not null/i);
  const names = ["014_inventory_operational_dates.sql", "014_platform_engine_rls.sql", "015_workspace_v2_indexes.sql"]
    .sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(names, ["014_inventory_operational_dates.sql", "014_platform_engine_rls.sql", "015_workspace_v2_indexes.sql"]);
});

test("workspace v2 sale submission preserves cart item snapshots across lazy catalog searches", () => {
  const handler = source("client/actions/handlers/catalog.js");
  assert.match(handler, /const loadedProduct = appData\.products\.find/);
  assert.match(handler, /loadedProduct \|\| \(item\.productId \? \{/);
  assert.match(handler, /id: item\.productId/);
  assert.match(handler, /name: item\.product \|\| "Produto"/);
});

test("workspace v2 operational pager keeps the requested local page until the server responds", () => {
  const list = source("client/components/OperationalList.jsx");
  assert.match(list, /const safePage = Math\.min\(Math\.max\(1, page\), totalPages\)/);
  assert.doesNotMatch(list, /backendPage !== page/);
  assert.match(list, /if \(page > totalPages\) setPage\(totalPages\)/);
});

test("workspace v2 uses the shared operational pager for company audit events", () => {
  const main = source("client/main.jsx");
  const queries = source("modules/core/runtime/services/dataQueryService.js");
  assert.match(main, /function UsersAudit[\s\S]*runtimeOperationalListProps\(runtimeData, "auditLogs"\)/);
  assert.doesNotMatch(main, /function UsersAudit[\s\S]*runtimeData\.loadResource\("auditLogs"/);
  assert.match(queries, /const requestedStatus = normalizedFilter\(input\.status \|\| input\.filter\)/);
  assert.match(queries, /\["todos", "all"\]\.includes\(requestedStatus\) \? "" : requestedStatus/);
});

test("workspace v2 uses one stock-critical boundary and accepts formatted OS identifiers", () => {
  const queries = source("modules/core/runtime/services/dataQueryService.js");
  const inventory = source("modules/core/runtime/services/inventoryService.js");
  assert.match(queries, /const availableStock = `\(coalesce\(st\.quantity,0\)-coalesce\(sr\.quantity,0\)\)`/);
  assert.doesNotMatch(queries, /\$\{availableStock\} < p\.minimum_stock/);
  assert.match(queries, /\$\{availableStock\} <= p\.minimum_stock/);
  assert.match(queries, /\$\{availableStock\} > p\.minimum_stock/);
  assert.match(inventory, /coalesce\(physical\.quantity, 0\) - coalesce\(reserved\.quantity, 0\)/);
  assert.match(queries, /concat\('OS-',so\.number::text\)/);
});

test("workspace v2 reports never fall back to partial lazy collections after a server failure", () => {
  const main = source("client/main.jsx");
  assert.match(main, /const hasServerReports = Boolean\(runtimeData\?\.loadReports\)/);
  assert.match(main, /hasServerReports \? null : fallbackReportData/);
  assert.match(main, /Nao foi possivel carregar os relatorios/);
});
