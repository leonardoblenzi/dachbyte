"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { _test, retry } = require("../src/services/GiftCampaignService");

function repository(actions = []) {
  return {
    actions,
    async setGiftCampaignState() { return null; },
    async appendGiftCampaignAction(input) { actions.push({ action: input.action, payload: input.payload }); return null; },
  };
}
function campaign(overrides = {}) {
  return {
    id: "c1", shopId: 1, name: "Campanha Setembro", status: "queued", logisticsResolution: "adjust_gifts", conflictPolicy: "skip", minSpendCents: 10000,
    startAt: "2026-10-10T12:00:00.000Z", endAt: "2026-10-20T12:00:00.000Z",
    mainItems: [{ pricingKey: "1:0", itemId: "1", costCents: 10000 }],
    giftItems: [{ pricingKey: "2:0", itemId: "2", costCents: 900 }],
    preview: { approvedPriceKeys: ["1:0"], lines: [{ key: "1:0", suggestedPriceCents: 16800 }] },
    actions: [], ...overrides,
  };
}
function liveCompatible() {
  return [
    { item_id: 1, logistic_info: [{ logistic_id: 1, logistic_name: "Logistica do vendedor", enabled: true }, { logistic_id: 80012, logistic_name: "Shopee Xpress", enabled: false }] },
    { item_id: 2, logistic_info: [{ logistic_id: 2, logistic_name: "Logistica do vendedor", enabled: false }, { logistic_id: 80012, logistic_name: "Shopee Xpress", enabled: true }] },
  ];
}
test("rascunho mantem o nome validado sem chamar a Shopee", async () => {
  let remoteCalls = 0;
  const result = await _test.createDraftWithDependencies({ repository: { createGiftCampaign: async (input) => ({ id: "draft-1", ...input }) }, remote: { createGiftWithMinimumSpend: async () => { remoteCalls += 1; } }, input: { shopId: 1, userId: 9, name: "Brinde Setembro", minSpendCents: 10000 } });
  assert.equal(result.name, "Brinde Setembro");
  assert.equal(remoteCalls, 0);
});
test("converte targetKinds em logistic_info real e registra checkpoints", async () => {
  const actions = [];
  const updates = [];
  const remoteCalls = [];
  await _test.publishWithDependencies({
    campaign: campaign(), repository: repository(actions),
    dependencies: { logistics: { getProductsBaseInfo: async () => liveCompatible(), updateProductLogistics: async (input) => updates.push(input) }, writes: { updatePrice: async () => null }, priceValidation: async ({ items }) => ({ items }), invalidateCatalog: async () => false },
    remote: { createGiftWithMinimumSpend: async (input) => { remoteCalls.push(["create", input]); return { addOnDealId: 77 }; }, addMainItems: async () => remoteCalls.push(["main"]), addGiftItems: async () => remoteCalls.push(["gift"]) },
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].logistics.map((entry) => entry.enabled), [true, false]);
  assert.equal(remoteCalls[0][1].name, "Campanha Setembro");
  assert.ok(actions.some((entry) => entry.action === "external_effect_started" && entry.payload.stepKey === "logistics:2"));
  assert.ok(actions.some((entry) => entry.action === "external_effect_completed" && entry.payload.stepKey === "campaign:add_gift_items"));
});
test("revalidacao inviavel interrompe antes de qualquer efeito externo", async () => {
  let writes = 0;
  let remote = 0;
  await assert.rejects(() => _test.publishWithDependencies({
    campaign: campaign(), repository: repository(),
    dependencies: { logistics: { getProductsBaseInfo: async () => [{ item_id: 1, logistic_info: [{ logistic_id: 1, logistic_name: "Logistica do vendedor", enabled: true }] }, { item_id: 2, logistic_info: [{ logistic_id: 80012, logistic_name: "Shopee Xpress", enabled: true }] }], updateProductLogistics: async () => { throw new Error("nao deveria executar"); } }, writes: { updatePrice: async () => { writes += 1; } }, priceValidation: async ({ items }) => ({ items }), invalidateCatalog: async () => false },
    remote: { createGiftWithMinimumSpend: async () => { remote += 1; } },
  }), /logistica mudou/i);
  assert.equal(writes, 0);
  assert.equal(remote, 0);
});
test("retry pede nova execucao explicita ao enfileirador", async () => {
  const calls = [];
  const saved = campaign({ status: "partial_failed" });
  const result = await retry({ shop: { id: 1 }, userId: 9, campaignId: "c1", enqueue: async (...args) => calls.push(args), repository: { async getGiftCampaign() { return saved; }, async setGiftCampaignState() {}, async appendGiftCampaignAction() {} } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["c1", { retry: true }]);
  assert.equal(result.id, "c1");
});
test("aplica apenas os precos explicitamente aprovados", async () => {
  const priceUpdates = [];
  await _test.publishWithDependencies({
    campaign: campaign({
      mainItems: [
        { pricingKey: "1:0", itemId: "1", costCents: 10000 },
        { pricingKey: "3:0", itemId: "3", costCents: 10000 },
      ],
      preview: {
        approvedPriceKeys: ["1:0"],
        lines: [
          { key: "1:0", suggestedPriceCents: 16800 },
          { key: "3:0", suggestedPriceCents: 17200 },
        ],
      },
    }),
    repository: repository(),
    dependencies: {
      logistics: {
        getProductsBaseInfo: async () => [
          ...liveCompatible(),
          { item_id: 3, logistic_info: [{ logistic_id: 1, logistic_name: "Logistica do vendedor", enabled: true }] },
        ],
        updateProductLogistics: async () => null,
      },
      writes: { updatePrice: async (input) => priceUpdates.push(input) },
      priceValidation: async ({ items }) => ({ items }),
      invalidateCatalog: async () => false,
    },
    remote: { createGiftWithMinimumSpend: async () => ({ addOnDealId: 77 }), addMainItems: async () => null, addGiftItems: async () => null },
  });
  assert.equal(priceUpdates.length, 1);
  assert.equal(priceUpdates[0].body.item_id, 1);
});
test("limite de duracao vem da configuracao do servidor, nao do corpo", () => {
  const previous = process.env.SHOPEE_ADD_ON_DEAL_MAX_DURATION_DAYS;
  process.env.SHOPEE_ADD_ON_DEAL_MAX_DURATION_DAYS = "2";
  try {
    const result = _test.previewFor({
      mainItems: [{ key: "1:0", costCents: 10000 }],
      giftItems: [{ key: "2:0", costCents: 900 }],
      startAt: "2099-10-10T12:00:00.000Z",
      endAt: "2099-12-10T12:00:00.000Z",
      useMaxDuration: true,
      maximumDurationDays: 999,
      targetMarginRate: 0.2,
    });
    assert.equal(result.period.endAt, "2099-10-12T12:00:00.000Z");
  } finally {
    if (previous == null) delete process.env.SHOPEE_ADD_ON_DEAL_MAX_DURATION_DAYS;
    else process.env.SHOPEE_ADD_ON_DEAL_MAX_DURATION_DAYS = previous;
  }
});
test("invalida o catalogo apos transicoes publicadas, parciais e canceladas", async () => {
  const publishedStates = [];
  await _test.publishWithDependencies({
    campaign: campaign(), repository: repository(),
    dependencies: {
      logistics: { getProductsBaseInfo: async () => liveCompatible(), updateProductLogistics: async () => null },
      writes: { updatePrice: async () => null },
      priceValidation: async ({ items }) => ({ items }),
      invalidateCatalog: async ({ shopId, status }) => publishedStates.push({ shopId, status }),
    },
    remote: { createGiftWithMinimumSpend: async () => ({ addOnDealId: 77 }), addMainItems: async () => null, addGiftItems: async () => null },
  });
  assert.deepEqual(publishedStates.filter((entry) => entry.status === "published"), [{ shopId: 1, status: "published" }]);

  const partialStates = [];
  await assert.rejects(() => _test.publishWithDependencies({
    campaign: campaign(), repository: repository(),
    dependencies: {
      logistics: { getProductsBaseInfo: async () => liveCompatible(), updateProductLogistics: async () => null },
      writes: { updatePrice: async () => null },
      priceValidation: async ({ items }) => ({ items }),
      invalidateCatalog: async ({ shopId, status }) => partialStates.push({ shopId, status }),
    },
    remote: { createGiftWithMinimumSpend: async () => ({ addOnDealId: 77 }), addMainItems: async () => null, addGiftItems: async () => { throw new Error("gift failed"); } },
  }), /gift failed/);
  assert.deepEqual(partialStates.filter((entry) => entry.status === "partial_failed"), [{ shopId: 1, status: "partial_failed" }]);

  const cancelledStates = [];
  const saved = campaign({ status: "draft" });
  await require("../src/services/GiftCampaignService").cancel({
    shop: { id: 1 }, userId: 9, campaignId: "c1",
    repository: { async getGiftCampaign() { return saved; }, async setGiftCampaignState() {} },
    invalidateCatalog: async ({ shopId, status }) => cancelledStates.push({ shopId, status }),
  });
  assert.deepEqual(cancelledStates, [{ shopId: 1, status: "cancelled" }]);
});
