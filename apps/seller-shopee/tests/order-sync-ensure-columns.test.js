"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Num banco novo a coluna "Order"."orderId" so existe depois de ensureOrderPackageColumns();
// toda consulta que le essa coluna precisa garantir isso antes.
test("leituras do Order que usam orderId garantem as colunas antes", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "repositories", "orderSyncSqlRepository.js"),
    "utf8",
  );
  for (const fn of [
    "listExistingOrdersByShopAndOrderSns",
    "updateExistingOrderCoreByShopAndOrderSn",
    "upsertOrderByShopAndOrderSn",
  ]) {
    const start = source.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `${fn} existe`);
    const body = source.slice(start, source.indexOf("\nasync function ", start + 10));
    const ensureAt = body.indexOf("await ensureOrderPackageColumns()");
    const readAt = body.indexOf('"orderId" AS order_id');
    assert.ok(ensureAt > 0, `${fn} chama ensureOrderPackageColumns`);
    assert.ok(readAt < 0 || ensureAt < readAt, `${fn} garante a coluna antes de ler`);
  }
});
