const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGiftCampaignLogisticsOptions } = require("../src/services/GiftCampaignLogisticsService");

test("mostra ajuste de brindes e de principais quando ambos s\u00e3o poss\u00edveis", () => {
  const result = buildGiftCampaignLogisticsOptions({
    mainItems: [{ itemId: "1", availableKinds: ["seller", "spx"], enabledKinds: ["seller"] }],
    giftItems: [{ itemId: "2", availableKinds: ["seller", "spx"], enabledKinds: ["spx"] }],
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.options.map((option) => option.id), ["adjust_gifts", "adjust_main_items", "edit_selection"]);
  assert.equal(result.options[0].feasible, true);
  assert.equal(result.options[1].feasible, true);
});

test("mant\u00e9m alternativa invi\u00e1vel vis\u00edvel com motivo f\u00edsico", () => {
  const result = buildGiftCampaignLogisticsOptions({
    mainItems: [{ itemId: "1", availableKinds: ["spx"], enabledKinds: ["spx"] }],
    giftItems: [{ itemId: "2", availableKinds: ["seller"], enabledKinds: ["seller"], spxPhysicalEligible: false, spxEligibilityReasons: ["Peso excede o limite"] }],
  });

  assert.equal(result.options[0].feasible, false);
  assert.match(result.options[0].reason, /Peso excede o limite/);
  assert.equal(result.options[2].feasible, true);
});

test("normaliza o resumo real e reconhece canais seller e SPX compartilhados", () => {
  const realSummary = (itemId) => ({
    itemId,
    logistics: [
      { kind: "intelipost", enabled: true },
      { kind: "spx", enabled: true },
    ],
    shippingKinds: ["seller", "spx"],
    spxEnabled: true,
    spxPhysicalEligible: true,
    spxEligibilityReasons: [],
  });

  const result = buildGiftCampaignLogisticsOptions({
    mainItems: [realSummary("1")],
    giftItems: [realSummary("2")],
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.matrix.mainItems[0].availableKinds, ["seller", "spx"]);
  assert.deepEqual(result.matrix.giftItems[0].enabledKinds, ["seller", "spx"]);
  assert.deepEqual(result.options[0].targetKinds, ["seller", "spx"]);
});
