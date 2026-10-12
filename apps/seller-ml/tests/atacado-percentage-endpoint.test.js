"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AtacadoService = require("../services/atacadoService");

test("atacado mantém desconto sobre preço promocional e usa PxQ percentual", async () => {
  const originals = {
    fetchSingleItem: AtacadoService.fetchSingleItem,
    fetchSalePrice: AtacadoService.fetchSalePrice,
    fetchPriceVersion: AtacadoService.fetchPriceVersion,
    authFetch: AtacadoService.authFetch,
  };
  const calls = [];

  AtacadoService.fetchSingleItem = async () => ({
    id: "MLB123",
    status: "active",
    price: 90,
    original_price: 100,
    currency_id: "BRL",
    available_quantity: 20,
  });
  AtacadoService.fetchSalePrice = async () => 90;
  AtacadoService.fetchPriceVersion = async () => 17;
  AtacadoService.authFetch = async (_state, url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/prices-per-quantity/v1/recommendations")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ recommendations: [] }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: 18 }),
    };
  };

  try {
    const result = await AtacadoService.applyWholesaleForItem(
      { token: "token", creds: {} },
      "MLB123",
      {
        promo_only: true,
        dry_run: false,
        min_purchase_unit: 2,
        extra_discount_percent: 5,
        tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }],
      },
    );

    assert.equal(result.status, "applied");
    assert.equal(result.row.sale_price, 90);
    assert.equal(result.row.suggested_wholesale_price, 85.5);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/prices-per-quantity\/v1\/recommendations$/);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      item_id: "MLB123",
      range_item_quantities: [2],
      price: { standard_amount: 100, currency: "BRL" },
    });
    assert.match(calls[1].url, /\/items\/MLB123\/prices\/price-per-quantity\?remove-absolute-pxq=true$/);
    assert.equal(calls[1].init.headers["X-Version"], "17");

    const payload = JSON.parse(calls[1].init.body);
    assert.deepEqual(payload, {
      price_per_quantity: [{
        type: "discount_percentage",
        percentage: 5,
        conditions: {
          context_restrictions: ["channel_marketplace", "user_type_business"],
          min_purchase_unit: 2,
          eligible: true,
        },
      }],
    });
    assert.equal("amount" in payload.price_per_quantity[0], false);
  } finally {
    Object.assign(AtacadoService, originals);
  }
});
