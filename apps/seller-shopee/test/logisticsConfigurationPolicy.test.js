const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeLogistics,
  identifyChannelKind,
} = require("../src/utils/productLogistics");
const {
  normalizeTargetKinds,
  validateTargetKinds,
  buildTargetLogistics,
} = require("../src/domain/logisticsConfigurationPolicy");

function fixtureChannels() {
  return [
    { logistics_channel_name: "Logistica do vendedor", enabled: false },
    { logistics_channel_id: 91003, logistics_channel_name: "Shopee Xpress", enabled: false },
    { logistics_channel_id: 99123, logistics_channel_name: "Entrega de Item Grande/Pesado", enabled: false },
    { logistics_channel_id: 77777, logistics_channel_name: "Canal parceiro", name: "Canal parceiro", enabled: true },
    { logistics_channel_name: "Retire perto de voce", enabled: true },
  ];
}

function availableAnalysis(kinds) {
  return analyzeLogistics(fixtureChannels().filter((channel) => {
    const kind = identifyChannelKind(channel);
    const publicKind = kind === "intelipost" ? "seller" : kind;
    return kinds.includes(publicKind) || kind === "other" || kind === "pickup";
  }));
}

function enabled(logistics, kind) {
  const internalKind = kind === "seller" ? "intelipost" : kind;
  return logistics.some((channel) =>
    identifyChannelKind(channel) === internalKind && channel.enabled === true,
  );
}

test("normalizes public target kinds in canonical order", () => {
  assert.deepEqual(
    normalizeTargetKinds(["heavy", "seller", "spx", "seller", "pickup", "other"]),
    ["seller", "spx", "heavy"],
  );
});

test("accepts seller-only target", () => {
  const result = validateTargetKinds({
    targetKinds: ["seller"],
    analysis: availableAnalysis(["seller"]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.targetKinds, ["seller"]);
  assert.deepEqual(result.missingKinds, []);
});

test("accepts seller plus SPX target", () => {
  const result = validateTargetKinds({
    targetKinds: ["spx", "seller"],
    analysis: availableAnalysis(["seller", "spx"]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.targetKinds, ["seller", "spx"]);
});

test("accepts seller plus heavy target", () => {
  const result = validateTargetKinds({
    targetKinds: ["heavy", "seller"],
    analysis: availableAnalysis(["seller", "heavy"]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.targetKinds, ["seller", "heavy"]);
});

test("rejects target without seller", () => {
  const result = validateTargetKinds({
    targetKinds: ["spx"],
    analysis: availableAnalysis(["seller", "spx"]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "seller_required");
  assert.match(result.errors[0].message, /vendedor/i);
});

test("rejects SPX and heavy together", () => {
  const result = validateTargetKinds({
    targetKinds: ["seller", "spx", "heavy"],
    analysis: availableAnalysis(["seller", "spx", "heavy"]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "spx_heavy_conflict");
  assert.match(result.errors[0].message, /nao pode ser combinado/i);
});

test("rejects an unavailable managed channel", () => {
  const result = validateTargetKinds({
    targetKinds: ["seller", "heavy"],
    analysis: availableAnalysis(["seller"]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "channel_unavailable");
  assert.deepEqual(result.missingKinds, ["heavy"]);
});

test("builds seller plus heavy and preserves unmanaged channels", () => {
  const result = buildTargetLogistics({
    logistics: fixtureChannels(),
    targetKinds: ["seller", "heavy"],
  });

  assert.equal(result.ok, true);
  assert.equal(enabled(result.logistics, "seller"), true);
  assert.equal(enabled(result.logistics, "heavy"), true);
  assert.equal(enabled(result.logistics, "spx"), false);
  assert.equal(result.logistics.find((row) => row.name === "Canal parceiro").enabled, true);
  assert.equal(result.logistics.find((row) => row.logistics_channel_name === "Retire perto de voce").enabled, true);
  assert.equal(result.changed, true);
});

test("synchronizes mixed activation flags on a managed channel", () => {
  const logistics = [
    {
      logistics_channel_name: "Logistica do vendedor",
      enabled: false,
      is_enabled: true,
      selected: false,
      is_selected: true,
    },
  ];
  const result = buildTargetLogistics({ logistics, targetKinds: ["seller"] });
  const seller = result.logistics[0];

  assert.equal(result.ok, true);
  assert.equal(seller.enabled, true);
  assert.equal(seller.is_enabled, true);
  assert.equal(seller.selected, true);
  assert.equal(seller.is_selected, true);
  assert.equal(analyzeLogistics(result.logistics).sellerEnabled, true);
});

test("normalizes contradictory flags when the analyzer already sees the target state", () => {
  const unmanaged = {
    logistics_channel_name: "Canal parceiro",
    enabled: true,
    is_enabled: false,
  };
  const logistics = [
    {
      logistics_channel_name: "Logistica do vendedor",
      enabled: true,
      is_enabled: false,
      selected: false,
      is_selected: false,
    },
    unmanaged,
  ];
  const result = buildTargetLogistics({ logistics, targetKinds: ["seller"] });
  const seller = result.logistics[0];

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(seller.enabled, true);
  assert.equal(seller.is_enabled, true);
  assert.equal(seller.selected, true);
  assert.equal(seller.is_selected, true);
  assert.equal(result.logistics[1], unmanaged);
  assert.equal(result.logistics[1].is_enabled, false);
});

test("does not synthesize an absent Shopee channel", () => {
  const logistics = fixtureChannels().filter(
    (channel) => identifyChannelKind(channel) !== "heavy",
  );
  const result = buildTargetLogistics({ logistics, targetKinds: ["seller", "heavy"] });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "channel_unavailable");
  assert.equal(result.logistics, logistics);
  assert.deepEqual(result.missingKinds, ["heavy"]);
});

test("reports no change for an already-configured managed state", () => {
  const logistics = fixtureChannels().map((channel) => ({ ...channel }));
  logistics[0].enabled = true;
  logistics[1].enabled = true;

  const result = buildTargetLogistics({
    logistics,
    targetKinds: ["seller", "spx"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.logistics, logistics);
});

test("rejects pickup as a selectable target", () => {
  const result = validateTargetKinds({
    targetKinds: ["seller", "pickup"],
    analysis: availableAnalysis(["seller"]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "unsupported_target_kind");
  assert.deepEqual(result.errors[0].kinds, ["pickup"]);
});

test("seller plus SPX target removes heavy from an existing seller-heavy state", () => {
  const result = buildTargetLogistics({
    logistics: fixtureChannels().map((channel) => ({ ...channel, enabled: true })),
    targetKinds: ["seller", "spx"],
  });

  assert.equal(result.ok, true);
  assert.equal(enabled(result.logistics, "seller"), true);
  assert.equal(enabled(result.logistics, "spx"), true);
  assert.equal(enabled(result.logistics, "heavy"), false);
});
