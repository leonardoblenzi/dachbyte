"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogService } = require("../src/modules/catalog/service");

function fakeRepository() {
  const state = { items: [], listings: [], runs: [] };
  return {
    state,
    async startImportRun() { state.runs.push({ status: "running" }); return { id: state.runs.length }; },
    async finishImportRun(id, result) { state.runs[id - 1] = result; },
    async insertItems(_tenant, items) {
      for (const item of items) if (!state.items.some((i) => i.skuKey === item.skuKey)) state.items.push({ id: state.items.length + 1, ...item });
      return items.length;
    },
    async listItemsForMatching() { return state.items.map((i) => ({ id: i.id, skuKey: i.skuKey, ean: i.ean, name: i.name })); },
    async upsertListings(_account, rows) { state.listings.push(...rows); return rows.length; },
  };
}

test("importação cria itens por SKU e vincula os anúncios automaticamente", async () => {
  const repository = fakeRepository();
  const service = createCatalogService({ repository });
  const result = await service.importListings({
    tenantId: "t1", accountId: 7,
    listings: [
      { listingId: "MLB1", variationId: "11", channelSku: "BQ-PRETO", title: "Banqueta preta", stock: 4 },
      { listingId: "MLB1", variationId: "12", channelSku: "bq preto", title: "Banqueta preta", stock: 4 },
      { listingId: "MLB2", channelSku: null, title: "Sem SKU nenhum" },
    ],
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.linkedAuto, 2);
  assert.equal(result.unlinked, 1);
  assert.equal(repository.state.items.length, 1, "um item para o mesmo SKU normalizado");
  const unlinked = repository.state.listings.find((l) => l.listing_id === "MLB2");
  assert.equal(unlinked.item_id, null);
  assert.equal(unlinked.variation_id, "");
});

test("falha na importação fica registrada no histórico", async () => {
  const repository = fakeRepository();
  repository.upsertListings = async () => { throw new Error("banco fora"); };
  const service = createCatalogService({ repository });
  await assert.rejects(() => service.importListings({ tenantId: "t1", accountId: 1, listings: [{ listingId: "A", channelSku: "A" }] }));
  assert.equal(repository.state.runs[0].status, "failed");
  assert.match(repository.state.runs[0].error, /banco fora/);
});

test("vínculo manual inexistente responde 404", async () => {
  const service = createCatalogService({ repository: { linkManually: async () => null } });
  await assert.rejects(() => service.linkListing("t1", 1, 2), (error) => error.status === 404);
});
