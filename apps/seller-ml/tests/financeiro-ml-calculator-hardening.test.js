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

test("calculator refuses a missing account key instead of using a default tenant", async () => {
  await assert.rejects(
    Calculator.calculate({ price: 100, commission_rate_pct: 15 }),
    (error) => error.status === 409 && /conta/i.test(error.message),
  );
});

test("listing fee request carries available logistics context", () => {
  const url = Calculator._test.buildListingFeeUrl({
    price: 100,
    categoryId: "MLB123",
    listingTypeId: "gold_special",
    shippingMode: "me2",
    logisticType: "fulfillment",
  });

  assert.equal(url.searchParams.get("shipping_mode"), "me2");
  assert.equal(url.searchParams.get("logistic_type"), "fulfillment");
});

test("ML fee quote failure is explicit and never converted into a zero fee", async () => {
  Calculator._test.setListingPriceRequest(async () => {
    throw Object.assign(new Error("upstream unavailable"), { status: 503 });
  });
  await assert.rejects(
    Calculator._test.fetchListingFee({ token: "token" }, {
      price: 100,
      categoryId: "MLB123",
      listingTypeId: "gold_special",
    }),
    (error) => error.status === 502 && /tarifa.*indisponivel/i.test(error.message),
  );
  Calculator._test.setListingPriceRequest(async () => ({}));
  await assert.rejects(
    Calculator._test.fetchListingFee({ token: "token" }, {
      price: 100,
      categoryId: "MLB123",
      listingTypeId: "gold_special",
    }),
    (error) => error.status === 502 && /tarifa.*indisponivel/i.test(error.message),
  );
  Calculator._test.resetListingPriceRequest();
});

test("ML fee mode rejects a missing fee category or listing type", async () => {
  await assert.rejects(
    Calculator.calculate({ price: 100, use_ml_fee: true, category_id: "MLB123" }, { accountKey: "drossi" }),
    (error) => error.status === 400 && /categoria.*tipo de anuncio/i.test(error.message),
  );
});

test("manual fee mode remains available without listing fee metadata", async () => {
  const result = await Calculator.calculate({
    price: 100,
    use_ml_fee: false,
    commission_rate_pct: 15,
  }, { accountKey: "drossi" });
  assert.equal(result.fee_mode, "manual");
  assert.equal(result.commission.amount, 15);
});

test("calculator lookup ownership rejects missing and mismatched ML sellers", () => {
  const owned = Calculator._test.filterOwnedItems([
    { id: "MLB123456789", seller_id: null },
    { id: "MLB123456790", seller_id: "999" },
    { id: "MLB123456791", seller_id: "10" },
  ], "10");
  assert.deepEqual(owned.map((item) => item.id), ["MLB123456791"]);
});
