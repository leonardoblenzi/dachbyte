"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { targetKey, variationName, gtinValues, classifyRows } = require("../services/bulkSkuPreviewService");

test("target identity distinguishes unitary and variation rows", () => {
  assert.equal(targetKey("mlb123456", ""), "MLB123456:");
  assert.equal(targetKey("MLB123456", "987"), "MLB123456:987");
  assert.equal(variationName([{ value_name: "Azul" }, { value_name: "P" }]), "Azul / P");
  assert.equal(variationName([]), "Produto único");
  assert.deepEqual(gtinValues([{ id: "GTIN", value_name: "07891234567890,7891234567890" }]), ["07891234567890", "7891234567890"]);
});

test("preview separates ready, unchanged, divergent and duplicate rows", () => {
  const base = { conta: "Loja A", mlb: "MLB123456", id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "07891234567890", sku_atual: "OLD", sku_novo: "NEW" };
  const live = new Map([[targetKey(base.mlb, ""), { sku: "OLD", ean: "07891234567890" }]]);
  const rows = classifyRows([base, { ...base, mlb: "MLB123457", sku_novo: "OLD" }, { ...base, mlb: "MLB123458", conta: "Loja B" }, { ...base }], live, "Loja A");
  assert.deepEqual(rows.map((row) => row.state), ["ready", "missing", "divergent", "invalid"]);
  assert.equal(classifyRows([{ ...base, sku_novo: "OLD" }], live, "Loja A")[0].state, "unchanged");
  assert.equal(classifyRows([{ ...base, sku_atual: "OTHER" }], live, "Loja A")[0].state, "divergent");
  assert.equal(classifyRows([{ ...base, ean_gtin_atual: "DIFFERENT" }], live, "Loja A")[0].warning, "EAN/GTIN mudou no ML");
});

test("a malformed spreadsheet cell is rejected before duplicate tracking or ML writes", () => {
  const row = { conta: "Loja", mlb: "MLB123456", id_variacao: "", sku_atual: "OLD", sku_novo: "#N/A", input_error: "SKU novo contém erro #N/A." };
  const live = new Map([[targetKey(row.mlb, ""), { sku: "OLD", ean: "" }]]);
  const classified = classifyRows([row, { ...row, sku_novo: "NEW", input_error: undefined }], live, "Loja");
  assert.equal(classified[0].state, "error");
  assert.match(classified[0].message, /#N\/A/);
  assert.equal(classified[1].state, "ready");
});
