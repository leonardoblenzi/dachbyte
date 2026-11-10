"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

test("migracao cria as colunas de Order usadas pela sincronizacao e pelos paineis", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "migrations", "20261110150000_order_sync_missing_columns", "migration.sql"),
    "utf8",
  );
  for (const column of ["orderId", "orderNumber", "estimatedShippingFeeCents", "shippingCarrier", "paymentMethod"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
});

test("migracao cria as colunas de repasse que o painel e a margem leem", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "migrations", "20261110160000_order_income_columns", "migration.sql"),
    "utf8",
  );
  const repo = fs.readFileSync(path.join(__dirname, "..", "src", "repositories", "orderSyncSqlRepository.js"), "utf8");
  const update = repo.slice(repo.indexOf("async function updateOrderIncomeByOrderSn("));
  const written = [...update.slice(0, update.indexOf("\n}\n")).matchAll(/"((?:fin|income)[A-Za-z]+)" = \$/g)].map((m) => m[1]);
  assert.ok(written.length >= 13);
  for (const column of written.filter((c) => c !== "incomeDetailRaw")) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`), column);
  }
});
