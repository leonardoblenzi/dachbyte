"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ShopeeProductService = require("../src/services/ShopeeProductService");

test("expoe a consulta de arvore de atributos da Shopee", () => {
  assert.equal(typeof ShopeeProductService.getAttributeTree, "function");
  assert.match(
    ShopeeProductService.getAttributeTree.toString(),
    /\/api\/v2\/product\/get_attribute_tree/,
  );
});
