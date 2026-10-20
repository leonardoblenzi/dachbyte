"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { exportWorkbook, parseWorkbook } = require("../services/bulkSkuWorkbookService");

test("workbook round-trip preserves GTIN and variation identifiers as text", async () => {
  const rows = [{ conta: "Loja A", mlb: "MLB123456", id_variacao: "000987", nome_variacao: "Azul / P", ean_gtin_atual: "07891234567890", sku_atual: "OLD", sku_novo: "NEW" }];
  const parsed = await parseWorkbook(await exportWorkbook(rows));
  assert.deepEqual(parsed, rows);
});

test("unitary item round-trip", async () => {
  const rows = [{ conta: "Loja A", mlb: "MLB123456", id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "", sku_atual: "OLD", sku_novo: "NEW" }];
  assert.deepEqual(await parseWorkbook(await exportWorkbook(rows)), rows);
});
