"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/controllers/CostsController");

test("importacao de custos aceita o cabecalho PRECO exportado por arquivos antigos", () => {
  assert.deepEqual(_test.parseImportedCostRows([{ ID: "123456", PRECO: "40,50" }]), [
    { itemId: "123456", cost: 40.5 },
  ]);
});

test("importacao de custos aceita o cabecalho PREÇO padrao", () => {
  assert.deepEqual(_test.parseImportedCostRows([{ ID: "123456", "PREÇO": "40,50" }]), [
    { itemId: "123456", cost: 40.5 },
  ]);
});
test("importacao preserva ponto decimal do XLSX exportado", () => {
  assert.deepEqual(_test.parseImportedCostRows([{ ID: "123456", "PREÇO": "40.50" }]), [
    { itemId: "123456", cost: 40.5 },
  ]);
});