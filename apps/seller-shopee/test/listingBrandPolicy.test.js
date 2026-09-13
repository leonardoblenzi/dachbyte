"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildShopeeBrand,
  resolveBrandDisplayName,
} = require("../src/domain/listingBrandPolicy");

test("preenche Sem marca no formulario quando a origem nao possui marca", () => {
  assert.equal(resolveBrandDisplayName(""), "Sem marca");
  assert.equal(resolveBrandDisplayName("  Nike  "), "Nike");
});

test("envia a representacao oficial No Brand para a Shopee", () => {
  assert.deepEqual(buildShopeeBrand({ brandId: null, brandName: "Sem marca" }), {
    brand_id: 0,
    original_brand_name: "No Brand",
  });
  assert.deepEqual(buildShopeeBrand({ brandId: null, brandName: "" }), {
    brand_id: 0,
    original_brand_name: "No Brand",
  });
});

test("preserva marcas reais e IDs oficiais", () => {
  assert.deepEqual(buildShopeeBrand({ brandId: "99", brandName: "Marca X" }), {
    brand_id: 99,
    original_brand_name: "Marca X",
  });
  assert.deepEqual(buildShopeeBrand({ brandId: null, brandName: "Marca Livre" }), {
    brand_id: 0,
    original_brand_name: "Marca Livre",
  });
});
