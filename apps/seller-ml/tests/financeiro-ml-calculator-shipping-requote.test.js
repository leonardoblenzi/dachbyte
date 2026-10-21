"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Calculator = require("../services/financeiroMlCalculatorService");

const item = {
  id: "MLB4342623549",
  seller_id: 123,
  price: 65.65,
  listing_type_id: "gold_special",
  shipping: { mode: "me2", free_shipping: false, logistic_type: "xd_drop_off" },
};
const context = { accountKey: "test-account", mlCreds: { access_token: "test" } };

test("shipping requote uses the simulated price and verifies listing ownership", async () => {
  const calls = [];
  const result = await Calculator.shippingQuote({ item_id: item.id, price: 30 }, context, {
    prepareAuthState: async () => ({ token: "test" }),
    sellerInfo: async () => ({ id: "123" }),
    fetchItemBodies: async (_state, ids) => { calls.push(ids); return [item]; },
    fetchSellerShipping: async (_state, listed, sellerId, price) => {
      calls.push([listed.id, sellerId, price]);
      return { seller_cost: 8.75, source: "users_shipping_options_free" };
    },
  });
  assert.deepEqual(calls, [[item.id], [item.id, "123", 30]]);
  assert.deepEqual(result, {
    success: true, item_id: item.id, price: 30, available: true,
    seller_shipping: 8.75, source: "users_shipping_options_free",
  });
});

test("shipping requote rejects a listing from another account", async () => {
  await assert.rejects(() => Calculator.shippingQuote({ item_id: item.id, price: 30 }, context, {
    prepareAuthState: async () => ({}),
    sellerInfo: async () => ({ id: "999" }),
    fetchItemBodies: async () => [item],
    fetchSellerShipping: async () => { throw new Error("must not quote"); },
  }), { status: 404 });
});

test("shipping requote marks an unavailable ML estimate instead of returning zero", async () => {
  const result = await Calculator.shippingQuote({ item_id: item.id, price: 30 }, context, {
    prepareAuthState: async () => ({}),
    sellerInfo: async () => ({ id: "123" }),
    fetchItemBodies: async () => [item],
    fetchSellerShipping: async () => ({ seller_cost: 0, source: "unavailable" }),
  });
  assert.equal(result.available, false);
  assert.equal(result.seller_shipping, null);
});

test("shipping requote never treats a missing source as a valid zero-cost quote", async () => {
  const result = await Calculator.shippingQuote({ item_id: item.id, price: 30 }, context, {
    prepareAuthState: async () => ({}),
    sellerInfo: async () => ({ id: "123" }),
    fetchItemBodies: async () => [item],
    fetchSellerShipping: async () => ({ seller_cost: 0 }),
  });
  assert.equal(result.available, false);
  assert.equal(result.seller_shipping, null);
});

test("shipping requote does not convert an absent seller cost into zero", async () => {
  const result = await Calculator.shippingQuote({ item_id: item.id, price: 30 }, context, {
    prepareAuthState: async () => ({}),
    sellerInfo: async () => ({ id: "123" }),
    fetchItemBodies: async () => [item],
    fetchSellerShipping: async () => ({ seller_cost: null, source: "users_shipping_options_free" }),
  });
  assert.equal(result.available, false);
  assert.equal(result.seller_shipping, null);
});
