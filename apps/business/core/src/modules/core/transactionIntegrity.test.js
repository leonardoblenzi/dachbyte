"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("operational timestamps default to now and reject invalid or future instants", () => {
  const { resolveOperationalTimestamp } = require("./runtime/services/operationalTimestamp");
  const now = "2026-10-16T12:00:00.000Z";
  assert.equal(resolveOperationalTimestamp(null, now), now);
  assert.equal(resolveOperationalTimestamp("2026-10-15T12:00:00Z", now), "2026-10-15T12:00:00.000Z");
  assert.throws(() => resolveOperationalTimestamp("2026-10-17T12:00:00Z", now), (error) => error.code === "OPERATIONAL_DATE_IN_FUTURE");
  assert.throws(() => resolveOperationalTimestamp("banana", now), (error) => error.code === "OPERATIONAL_DATE_INVALID");
  assert.throws(() => resolveOperationalTimestamp("2026-10-16T09:00", now), (error) => error.code === "OPERATIONAL_DATE_INVALID");
});

test("all cash-producing operations resolve their supplied timestamp", () => {
  const service = (name) => fs.readFileSync(path.join(__dirname, "runtime", "services", `${name}.js`), "utf8");
  assert.match(service("salesService"), /resolveOperationalTimestamp\(input\.soldAt \|\| input\.sold_at/);
  assert.match(service("financeService"), /resolveOperationalTimestamp\(input\.operationalAt \|\| input\.operational_at \|\| input\.receivedAt/);
  assert.match(service("financeService"), /resolveOperationalTimestamp\(input\.operationalAt \|\| input\.operational_at \|\| input\.paidAt/);
  assert.match(service("cashService"), /resolveOperationalTimestamp\(input\.operationalAt \|\| input\.operational_at/);
});

test("a repeated receivable settlement returns without another cash movement", async () => {
  const db = require("../../../db/db");
  const finance = require("./runtime/services/financeService");
  const originalWithClient = db.withClient;
  const input = { idempotencyKey: "receive-123", amount: 10, paymentMethod: "pix" };
  const fingerprint = finance.__test.receivableSettlementFingerprint(input);
  let inserted = false;
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (["begin", "commit", "rollback"].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes("from volt_core.receivables") && text.includes("for update")) return { rowCount: 1, rows: [{ id: "rec-1", amount: 100, paidAmount: 10, status: "partial" }] };
      if (text.includes("from volt_core.cash_movements") && text.includes("idempotency_key")) return { rowCount: 1, rows: [{ idempotencyFingerprint: fingerprint }] };
      if (text.startsWith("insert into volt_core.cash_movements")) inserted = true;
      throw new Error(`Unexpected SQL on replay: ${text}`);
    },
  };
  db.withClient = async (fn) => fn(client);
  try {
    const result = await finance.receiveReceivable("company-a", "rec-1", input);
    assert.equal(result.paidAmount, 10);
    assert.equal(inserted, false);
  } finally {
    db.withClient = originalWithClient;
  }
});

test("stock tracking and archived sales preserve reservations and ledger history", () => {
  const root = path.join(__dirname, "runtime", "services");
  const catalog = fs.readFileSync(path.join(root, "catalogService.js"), "utf8");
  const sales = fs.readFileSync(path.join(root, "salesService.js"), "utf8");
  assert.match(catalog, /STOCK_TRACKING_HAS_ACTIVE_RESERVATIONS/);
  assert.match(sales, /const orderedItems = \[\.\.\.rawItems\]\.sort/);
  assert.match(sales, /set archived_at = now\(\)/);
  assert.doesNotMatch(sales, /delete from volt_core\.sales where company_id = \$1 and id = \$2/);
});

test("sale correction, cancellation and archive have separate permissions", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "core.routes.js"), "utf8");
  const { rolePresets } = require("./registries/permissions");
  assert.match(routes, /sales\/:saleId", requireRuntimePermission\("sales:correct"\)/);
  assert.match(routes, /sales\/:saleId\/cancel", requireRuntimePermission\("sales:cancel"\)/);
  assert.match(routes, /router\.delete\("\/runtime\/companies\/:companyId\/sales\/:saleId", requireRuntimePermission\("sales:archive"\)/);
  for (const permission of ["sales:correct", "sales:cancel", "sales:archive"]) {
    assert.ok(rolePresets.manager.permissions.includes(permission));
    assert.equal(rolePresets.operator.permissions.includes(permission), false);
  }
});

test("sale forms prefill and cap the company-local date", () => {
  const modal = fs.readFileSync(path.join(__dirname, "..", "..", "client", "modals", "config.js"), "utf8");
  const opticalState = fs.readFileSync(path.join(__dirname, "..", "..", "client", "extensions", "optical", "opticalSaleState.js"), "utf8");
  const opticalView = fs.readFileSync(path.join(__dirname, "..", "..", "client", "extensions", "optical", "OpticalSalesPdvView.jsx"), "utf8");
  assert.match(modal, /soldAt: payload\.soldAt \|\| formatCompanyDateTimeLocal\(companyTimezone\)/);
  assert.match(modal, /name: "soldAt"[^\n]*max: formatCompanyDateTimeLocal\(companyTimezone\)/);
  assert.match(opticalState, /soldAt: formatCompanyDateTimeLocal\(timezone\)/);
  assert.match(opticalView, /max=\{formatCompanyDateTimeLocal\(timezone\)\}/);
});
