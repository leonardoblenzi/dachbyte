"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AtacadoService = require("../services/atacadoService");

test("servico de atacado rejeita simulacao antiga antes de consultar o ML", async () => {
  await assert.rejects(
    () => AtacadoService.applyWholesaleForItem({}, "MLB123", { dry_run: true }),
    /simulação.*não.*disponível/i,
  );
});

test("atacado mantém desconto sobre preço promocional e usa PxQ percentual", async () => {
  const originals = {
    fetchSingleItem: AtacadoService.fetchSingleItem,
    fetchSalePrice: AtacadoService.fetchSalePrice,
    fetchPriceVersion: AtacadoService.fetchPriceVersion,
    fetchConfiguredPrices: AtacadoService.fetchConfiguredPrices,
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
  AtacadoService.fetchConfiguredPrices = async () => ({ price_per_quantity: [{
    type: "discount_percentage",
    percentage: 5,
    conditions: { min_purchase_unit: 2, context_restrictions: ["channel_marketplace", "user_type_business"], eligible: true },
  }] });
  AtacadoService.authFetch = async (_state, url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/prices-per-quantity/v1/recommendations")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ price: { sale_price_amount: 90 }, recommendations: [{ quantity: 2, amount: 85.5, is_incoherent_quantity: false }] }),
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

test("atacado rejeita quantidade incoerente antes de escrever", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, fetchPriceVersion: AtacadoService.fetchPriceVersion, authFetch: AtacadoService.authFetch };
  let writes = 0;
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: 100, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => 100;
  AtacadoService.fetchPriceVersion = async () => 17;
  AtacadoService.authFetch = async (_state, url) => {
    if (url.includes("price-per-quantity")) writes += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ price: { sale_price_amount: 100 }, recommendations: [{ quantity: 2, amount: 95, is_incoherent_quantity: true }] }) };
  };
  try {
    await assert.rejects(() => AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] }), /incoerente/i);
    assert.equal(writes, 0);
  } finally { Object.assign(AtacadoService, originals); }
});

test("atacado rejeita preço acima do recomendado antes de escrever", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, fetchPriceVersion: AtacadoService.fetchPriceVersion, authFetch: AtacadoService.authFetch };
  let writes = 0;
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: 100, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => 100;
  AtacadoService.fetchPriceVersion = async () => 17;
  AtacadoService.authFetch = async (_state, url) => {
    if (url.includes("price-per-quantity")) writes += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ price: { sale_price_amount: 100 }, recommendations: [{ quantity: 2, amount: 90, is_incoherent_quantity: false }] }) };
  };
  try {
    await assert.rejects(() => AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] }), /recomendado/i);
    assert.equal(writes, 0);
  } finally { Object.assign(AtacadoService, originals); }
});

test("atacado rejeita faixas além dos limites sem truncar", async () => {
  const original = AtacadoService.prepareState;
  AtacadoService.prepareState = async () => ({});
  try {
    for (const tier_configs of [
      [{ min_purchase_unit: 101, discount_percent: 5 }],
      [{ min_purchase_unit: 2, discount_percent: 100 }],
      Array.from({ length: 6 }, (_, index) => ({ min_purchase_unit: index + 2, discount_percent: index + 1 })),
    ]) {
      await assert.rejects(() => AtacadoService.applyWholesale({}, { item_ids: ["MLB123"], tier_configs }), /faixa|quantidade|desconto/i);
    }
  } finally { AtacadoService.prepareState = original; }
});

test("atacado revalida item e recomendações após conflito de versão", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, fetchPriceVersion: AtacadoService.fetchPriceVersion, fetchConfiguredPrices: AtacadoService.fetchConfiguredPrices, authFetch: AtacadoService.authFetch };
  let itemReads = 0;
  let recommendations = 0;
  let writes = 0;
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: ++itemReads === 1 ? 100 : 120, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => itemReads === 1 ? 100 : 120;
  AtacadoService.fetchPriceVersion = async () => itemReads === 1 ? 17 : 18;
  AtacadoService.fetchConfiguredPrices = async () => ({ price_per_quantity: [{ type: "discount_percentage", percentage: 5, conditions: { min_purchase_unit: 2, eligible: true, context_restrictions: ["channel_marketplace", "user_type_business"] } }] });
  AtacadoService.authFetch = async (_state, url, init) => {
    if (url.endsWith("/recommendations")) {
      recommendations += 1;
      const price = JSON.parse(init.body).price.standard_amount;
      return { ok: true, status: 200, text: async () => JSON.stringify({ price: { sale_price_amount: price }, recommendations: [{ quantity: 2, amount: price * 0.95, is_incoherent_quantity: false }] }) };
    }
    writes += 1;
    return { ok: writes !== 1, status: writes === 1 ? 409 : 200, text: async () => "{}" };
  };
  try {
    const result = await AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] });
    assert.equal(result.status, "applied");
    assert.equal(itemReads, 2);
    assert.equal(recommendations, 2);
    assert.equal(writes, 2);
    assert.equal(result.row.sale_price, 120);
  } finally { Object.assign(AtacadoService, originals); }
});

test("atacado não confirma aplicação quando leitura posterior diverge", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, fetchPriceVersion: AtacadoService.fetchPriceVersion, fetchConfiguredPrices: AtacadoService.fetchConfiguredPrices, authFetch: AtacadoService.authFetch };
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: 100, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => 100;
  AtacadoService.fetchPriceVersion = async () => 17;
  AtacadoService.fetchConfiguredPrices = async () => ({ price_per_quantity: [] });
  AtacadoService.authFetch = async (_state, url) => url.endsWith("/recommendations")
    ? { ok: true, status: 204, text: async () => "" }
    : { ok: true, status: 200, text: async () => "{}" };
  try {
    const result = await AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] });
    assert.notEqual(result.status, "applied");
    assert.match(result.reason, /confirm|verific/i);
  } finally { Object.assign(AtacadoService, originals); }
});

test("atacado não grava quando resposta 200 omite recomendação da faixa", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, authFetch: AtacadoService.authFetch };
  let writes = 0;
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: 100, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => 100;
  AtacadoService.authFetch = async (_state, url) => {
    if (!url.endsWith("/recommendations")) writes += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ recommendations: [] }) };
  };
  try {
    await assert.rejects(() => AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] }), /não recomendou/i);
    assert.equal(writes, 0);
  } finally { Object.assign(AtacadoService, originals); }
});

test("atacado aceita recomendação 204 e confirma por leitura posterior", async () => {
  const originals = { fetchSingleItem: AtacadoService.fetchSingleItem, fetchSalePrice: AtacadoService.fetchSalePrice, fetchPriceVersion: AtacadoService.fetchPriceVersion, fetchConfiguredPrices: AtacadoService.fetchConfiguredPrices, authFetch: AtacadoService.authFetch };
  let reads = 0;
  AtacadoService.fetchSingleItem = async () => ({ id: "MLB123", status: "active", price: 100, currency_id: "BRL" });
  AtacadoService.fetchSalePrice = async () => 100;
  AtacadoService.fetchPriceVersion = async () => 17;
  AtacadoService.fetchConfiguredPrices = async () => {
    reads += 1;
    return { price_per_quantity: reads === 1 ? [] : [{ type: "discount_percentage", percentage: 5, conditions: { min_purchase_unit: 2, context_restrictions: ["channel_marketplace", "user_type_business"] } }] };
  };
  AtacadoService.authFetch = async (_state, url) => url.endsWith("/recommendations")
    ? { ok: true, status: 204, text: async () => "" }
    : { ok: true, status: 200, text: async () => "{}" };
  try {
    const result = await AtacadoService.applyWholesaleForItem({}, "MLB123", { tier_configs: [{ min_purchase_unit: 2, discount_percent: 5 }] });
    assert.equal(result.status, "applied");
    assert.equal(reads, 2);
  } finally { Object.assign(AtacadoService, originals); }
});
