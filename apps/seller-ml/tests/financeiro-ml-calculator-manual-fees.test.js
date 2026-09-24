"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const nativeFetch = global.fetch;
const originalLoad = Module._load;
Module._load = function mockNodeFetch(request, parent, isMain) {
  if (request === "node-fetch") return nativeFetch;
  return originalLoad.call(this, request, parent, isMain);
};
const Calculator = require("../services/financeiroMlCalculatorService");
Module._load = originalLoad;

test("category discovery keeps only usable MLB suggestions", () => {
  assert.deepEqual(Calculator._test.normalizeCategorySuggestions([
    {
      category_id: "MLB1055",
      category_name: "Celulares",
      domain_id: "MLB-CELLPHONES",
      domain_name: "Celulares",
    },
    { category_id: "", category_name: "Inválida" },
  ]), [{
    id: "MLB1055",
    name: "Celulares",
    domain_id: "MLB-CELLPHONES",
    domain_name: "Celulares",
  }]);
});

test("category discovery URL follows the MLB predictor contract", () => {
  const url = Calculator._test.buildCategoryDiscoveryUrl("fone bluetooth");
  assert.equal(url.pathname, "/sites/MLB/domain_discovery/search");
  assert.equal(url.searchParams.get("q"), "fone bluetooth");
  assert.equal(url.searchParams.get("limit"), "3");
});
