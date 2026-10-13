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

const item = {
  id: "MLB6311005168",
  price: 35.9,
  listing_type_id: "gold_special",
  shipping: { mode: "me2", logistic_type: "xd_drop_off", free_shipping: false },
};

test("ME2 buyer-paid quotes the seller share with free_shipping=false", async () => {
  const urls = [];
  Calculator._test.setShippingQuoteRequest(async (_state, url) => {
    urls.push(new URL(url));
    return { coverage: { all_country: { list_cost: 8.4 } } };
  });
  try {
    const quote = await Calculator._test.fetchSellerShipping({ token: "test" }, item, "123", 35.9);
    assert.deepEqual(quote, { seller_cost: 8.4, source: "users_shipping_options_free" });
    assert.equal(urls[0].searchParams.get("free_shipping"), "false");
    assert.equal(urls[0].searchParams.get("item_id"), "MLB6311005168");
    assert.equal(urls[0].searchParams.get("logistic_type"), "xd_drop_off");
    assert.equal(urls.length, 1);
  } finally {
    Calculator._test.resetShippingQuoteRequest();
  }
});

test("ME2 preserves quoted zero and marks absent or failed quote unavailable", async () => {
  try {
    Calculator._test.setShippingQuoteRequest(async () => ({ coverage: { all_country: { list_cost: 0 } } }));
    assert.deepEqual(await Calculator._test.fetchSellerShipping({ token: "test" }, item, "123"),
      { seller_cost: 0, source: "users_shipping_options_free" });

    Calculator._test.setShippingQuoteRequest(async () => ({ coverage: {} }));
    assert.deepEqual(await Calculator._test.fetchSellerShipping({ token: "test" }, item, "123"),
      { seller_cost: 0, source: "unavailable" });

    Calculator._test.setShippingQuoteRequest(async () => ({ coverage: { all_country: { list_cost: "" } } }));
    assert.deepEqual(await Calculator._test.fetchSellerShipping({ token: "test" }, item, "123"),
      { seller_cost: 0, source: "unavailable" });

    Calculator._test.setShippingQuoteRequest(async () => { throw new Error("unavailable"); });
    assert.deepEqual(await Calculator._test.fetchSellerShipping({ token: "test" }, item, "123"),
      { seller_cost: 0, source: "unavailable" });
  } finally {
    Calculator._test.resetShippingQuoteRequest();
  }
});
