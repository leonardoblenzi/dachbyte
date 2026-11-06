"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { skuKey, eanKey, titleSimilarity } = require("../src/modules/catalog/normalize");
const { buildIndex, matchListing, deriveItemsFromListings } = require("../src/modules/catalog/matching");

test("SKU normaliza igual ao SKU Tracker (acento, caixa e separadores)", () => {
  assert.equal(skuKey(" Poltrona-Ação 01 "), "poltrona-acao-01");
  assert.equal(skuKey("POLTRONA_ACAO.01"), "poltrona-acao-01");
  assert.equal(skuKey(""), null);
  assert.equal(skuKey("---"), null);
});

test("EAN só vale com 8 a 14 dígitos e não zerado", () => {
  assert.equal(eanKey("789 1234 567890"), "7891234567890");
  assert.equal(eanKey("1234"), null);
  assert.equal(eanKey("00000000"), null);
  assert.equal(eanKey(null), null);
});

test("vínculo: SKU primeiro, depois EAN único, senão só sugestão por título", () => {
  const index = buildIndex([
    { id: 1, skuKey: "poltrona-01", ean: "7891234567890", name: "Poltrona Decorativa Stella Veludo Preto" },
    { id: 2, skuKey: "mesa-02", ean: "7890000000017", name: "Mesa de Jantar Melina 160 cm" },
    { id: 3, skuKey: "mesa-03", ean: "7890000000017", name: "Mesa Lateral" },
  ]);
  assert.deepEqual(matchListing({ channelSku: "POLTRONA 01" }, index), { itemId: 1, method: "auto_sku", suggestionItemId: null, reason: "sku" });
  assert.equal(matchListing({ channelSku: "outro", ean: "7891234567890" }, index).method, "auto_ean");
  // EAN repetido em dois itens não casa sozinho.
  assert.equal(matchListing({ channelSku: "outro", ean: "7890000000017" }, index).itemId, null);
  const suggestion = matchListing({ channelSku: null, title: "Poltrona Stella Veludo Preto Decorativa" }, index);
  assert.equal(suggestion.itemId, null);
  assert.equal(suggestion.suggestionItemId, 1);
  assert.equal(matchListing({ channelSku: null, title: "Cadeira de escritório" }, index).reason, "no_sku");
});

test("similaridade de título ignora palavras vazias", () => {
  assert.equal(titleSimilarity("Kit de Mesa", "mesa"), 1);
  assert.equal(titleSimilarity("", "mesa"), 0);
});

test("itens mestres derivados dos anúncios: um por SKU, nome mais frequente", () => {
  const items = deriveItemsFromListings([
    { channelSku: "SKU-1", title: "Sofá Retrô", ean: "7891234567890" },
    { channelSku: "sku 1", title: "Sofá Retrô", ean: "7891234567890" },
    { channelSku: "SKU-1", title: "Sofa retro azul" },
    { channelSku: "SKU-2", title: "Rack" },
    { channelSku: null, title: "Sem SKU" },
  ]);
  assert.equal(items.length, 2);
  const first = items.find((i) => i.skuKey === "sku-1");
  assert.equal(first.name, "Sofá Retrô");
  assert.equal(first.ean, "7891234567890");
  assert.equal(first.listingCount, 3);
});
