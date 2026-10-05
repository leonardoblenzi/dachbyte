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

test("operacoes em massa usam a escala comercial aprovada", () => {
  assert.equal(calculateOperationCredits("promotions.apply", { units: 30000 }), 10);
  assert.equal(calculateOperationCredits("promotions.remove", { units: 30000 }), 10);
  assert.equal(calculateOperationCredits("promotions.validate", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("promotions.reapply_recent", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("wholesale.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("wholesale.validate", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("characteristics.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("characteristics.validate", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("mass-model.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("mass-model.validate", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("production-time.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("production-time.lookup", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("dimensions.validate", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("dimensions.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("stock.scan", { units: 30000 }), 2);
  assert.equal(calculateOperationCredits("stock.apply", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("listing.activate", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("listing.pause", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("listing.close", { units: 30000 }), 20);
  assert.equal(calculateOperationCredits("listing.relist", { units: 30000 }), 40);
  assert.equal(calculateOperationCredits("listing.pause-relist", { units: 30000 }), 50);
  assert.equal(calculateOperationCredits("listing.bulk-delete", { units: 30000 }), 30);
});

test("operacao desconhecida falha explicitamente", () => {
  assert.throws(
    () => calculateOperationCredits("unknown.operation", { units: 1 }),
    /unknown_credit_operation/,
  );
});
