"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateOperationCredits,
  estimateAdsFilterCredits,
} = require("../services/mlCreditCosts");

test("consulta simples de anuncios parte de cinco creditos", () => {
  assert.equal(estimateAdsFilterCredits({}), 5);
});

test("enriquecimentos de anuncios somam apenas uma vez", () => {
  assert.equal(
    estimateAdsFilterCredits({
      has_period: true,
      include_visits: true,
      include_ads: true,
      include_promos: true,
      include_category: true,
      detail_variations: true,
    }),
    25,
  );
});

test("operacoes em massa crescem por unidade configurada", () => {
  assert.equal(calculateOperationCredits("promotions.apply", { units: 10 }), 12);
  assert.equal(calculateOperationCredits("promotions.validate", { units: 10 }), 4);
  assert.equal(calculateOperationCredits("dimensions.validate", { units: 10 }), 7);
});

test("operacao desconhecida falha explicitamente", () => {
  assert.throws(
    () => calculateOperationCredits("unknown.operation", { units: 1 }),
    /unknown_credit_operation/,
  );
});
