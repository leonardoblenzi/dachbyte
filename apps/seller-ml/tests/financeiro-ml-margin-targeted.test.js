"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const fetchPath = require.resolve("node-fetch");
const originalFetch = require("node-fetch");
let responder = async () => ({ status: 200, body: {} });
require.cache[fetchPath].exports = async (url) => {
  const answer = await responder(new URL(url));
  return new originalFetch.Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
};
const service = require("../services/financeiroMlService");
require.cache[fetchPath].exports = originalFetch;

test("direct margin SKU lookup finds a listing outside the inventory snapshot", async () => {
  responder = async (url) => {
    if (url.pathname.endsWith("/items/search")) {
      return { status: 200, body: { results: url.searchParams.get("status") === "active" ? ["MLB5329848148"] : [], paging: { total: 1 } } };
    }
    if (url.pathname === "/items/bulk") {
      return { status: 200, body: [{ code: 200, body: {
        id: "MLB5329848148", seller_id: 123, status: "active", title: "Produto",
        seller_sku: "ABC-10", price: 100,
      } }] };
    }
    throw new Error(`Unexpected API path: ${url.pathname}`);
  };
  const items = await service._test.fetchTargetedCostLookupItems(
    { accessToken: "test" }, { q: "ABC-10", lookup_type: "sku", status: "all" }, { id: 123 }, { strict: true },
  );
  assert.deepEqual(items.map((item) => item.item_id), ["MLB5329848148"]);
});

test("strict margin lookup reports ML search failure instead of returning no match", async () => {
  responder = async (url) => {
    if (url.pathname.endsWith("/items/search")) return { status: 503, body: { message: "ML unavailable" } };
    throw new Error(`Unexpected API path: ${url.pathname}`);
  };
  await assert.rejects(service._test.fetchTargetedCostLookupItems(
    { accessToken: "test" }, { q: "ABC-10", lookup_type: "sku", status: "all" }, { id: 123 }, { strict: true },
  ), /ML unavailable/);
});
