"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateListingRecord, MarketplaceConnector, CHANNELS } = require("../src/connectors/contract");
const ml = require("../src/connectors/mercadolivre/mapper");
const magalu = require("../src/connectors/magalu/mapper");
const shopee = require("../src/connectors/shopee/mapper");

// Respostas de exemplo no formato das APIs (dados fictícios).
const ML_ITEM_WITH_VARIATIONS = {
  id: "MLB100", title: "Banqueta Kit 3 Industrial", status: "active", price: 1286.9,
  shipping: { logistic_type: "cross_docking" },
  attributes: [{ id: "GTIN", value_name: "7891234567890" }],
  variations: [
    { id: 11, available_quantity: 4, price: 1286.9, attributes: [{ id: "SELLER_SKU", value_name: "BQ-PRETO" }] },
    { id: 12, available_quantity: 0, price: 1286.9, seller_custom_field: "BQ-BRANCO" },
  ],
};
const ML_ITEM_FULL = { id: "MLB200", title: "Sofá Retrô", status: "active", price: 999, available_quantity: 7, seller_custom_field: "SOFA-1", shipping: { logistic_type: "fulfillment" } };
const MAGALU_SKU = { sku: "126339", title: "Cristaleira Mia", status: "PUBLISHED", fulfillment: false, identifiers: [{ type: "EAN", value: "7890000000017" }] };
const MAGALU_PRICE = { results: [{ price: 177790, normalizer: 100 }] };
const MAGALU_STOCK = { results: [{ type: "AVAILABLE", quantity: 600, branch: { id: "a" } }, { type: "RESERVED", quantity: 5 }, { type: "AVAILABLE", quantity: 400, branch: { id: "b" } }] };
const SHOPEE_ITEM = { item_id: 23095390623, item_name: "Aparador Horus 160 cm", item_status: "NORMAL", item_sku: "HORUS", has_model: true };
const SHOPEE_MODELS = [
  { model_id: 1, model_sku: "HORUS-PRETO", stock_info_v2: { summary_info: { total_available_stock: 10 } }, price_info: [{ current_price: 707.9 }] },
  { model_id: 2, model_sku: "", stock_info_v2: { summary_info: { total_available_stock: 0 } }, price_info: [{ current_price: 707.9 }] },
];

const recordsByChannel = {
  mercadolivre: [...ml.mapItem(ML_ITEM_WITH_VARIATIONS), ...ml.mapItem(ML_ITEM_FULL)],
  magalu: [magalu.mapSku({ sku: MAGALU_SKU, price: MAGALU_PRICE, stock: MAGALU_STOCK })],
  shopee: shopee.mapItem(SHOPEE_ITEM, SHOPEE_MODELS),
};

test("os três conectores produzem o mesmo formato de anúncio", () => {
  assert.deepEqual(Object.keys(recordsByChannel).sort(), [...CHANNELS].sort());
  for (const [channel, records] of Object.entries(recordsByChannel)) {
    assert.ok(records.length > 0, channel);
    for (const record of records) assert.deepEqual(validateListingRecord(record), [], `${channel}: ${JSON.stringify(record)}`);
  }
});

test("Mercado Livre: um registro por variação, SKU por atributo ou campo, Full marcado", () => {
  const [preto, branco, full] = recordsByChannel.mercadolivre;
  assert.equal(preto.variationId, "11");
  assert.equal(preto.channelSku, "BQ-PRETO");
  assert.equal(preto.ean, "7891234567890");
  assert.equal(branco.channelSku, "BQ-BRANCO");
  assert.equal(branco.stock, 0);
  assert.equal(full.fulfillment, true);
  assert.equal(full.variationId, "");
  assert.equal(ml.mapItemsBatch([{ code: 404, body: {} }, { code: 200, body: ML_ITEM_FULL }]).length, 1);
});

test("Magalu: preço com normalizer e estoque só AVAILABLE", () => {
  const [record] = recordsByChannel.magalu;
  assert.equal(record.price, 1777.9);
  assert.equal(record.stock, 1000);
  assert.equal(record.ean, "7890000000017");
  assert.equal(magalu.mapSku({ sku: {} }), null);
});

test("Shopee: um registro por modelo; modelo sem SKU usa o SKU do item", () => {
  const [preto, semSku] = recordsByChannel.shopee;
  assert.equal(preto.channelSku, "HORUS-PRETO");
  assert.equal(preto.stock, 10);
  assert.equal(semSku.channelSku, "HORUS");
  assert.equal(shopee.mapItem({ item_id: 5, item_sku: "X", has_model: false, stock_info_v2: { summary_info: { total_available_stock: 3 } } }).length, 1);
});

test("contrato base obriga a implementar cada método", async () => {
  const connector = new MarketplaceConnector();
  assert.throws(() => connector.channel);
  await assert.rejects(() => connector.listListings({ id: 1, externalAccountId: "x", accessToken: "t" }, {}));
  assert.deepEqual(validateListingRecord({ listingId: "" }), ["listingId ausente"]);
});
