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
