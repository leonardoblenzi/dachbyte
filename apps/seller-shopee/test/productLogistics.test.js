const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeLogistics,
  identifyChannelKind,
} = require("../src/utils/productLogistics");

test("identifies Shopee Xpress channel 91003 by id", () => {
  assert.equal(
    identifyChannelKind({
      logistics_channel_id: 91003,
      logistics_channel_name: "Entrega Padrao",
    }),
    "spx",
  );
});

test("identifies Expresso Aereo channel 91006 as SPX", () => {
  assert.equal(
    identifyChannelKind({
      logistics_channel_id: 91006,
      logistics_channel_name: "Expresso Aereo",
    }),
    "spx",
  );
});

test("keeps SPX channel 91006 as SPX with a heavy-looking name", () => {
  assert.equal(
    identifyChannelKind({
      logistics_channel_id: 91006,
      logistics_channel_name: "Entrega de Item Grande/Pesado",
    }),
    "spx",
  );
});

test("identifies Entrega de Item Grande/Pesado as heavy", () => {
  assert.equal(
    identifyChannelKind({
      logistics_channel_id: 99123,
      logistics_channel_name: "Entrega de Item Grande/Pesado",
      enabled: true,
    }),
    "heavy",
  );
});

test("summarizes heavy and seller without marking SPX", () => {
  const analysis = analyzeLogistics([
    { logistics_channel_name: "Entrega de Item Grande/Pesado", enabled: true },
    {
      logistics_channel_name: "Logistica do vendedor - Intelipost",
      enabled: true,
    },
  ]);

  assert.equal(analysis.heavyEnabled, true);
  assert.equal(analysis.sellerEnabled, true);
  assert.equal(analysis.spxEnabled, false);
  assert.deepEqual(analysis.enabledKinds.sort(), ["heavy", "intelipost"]);
});

test("uses the enabled SPX channel when both logistics channels are returned", () => {
  const analysis = analyzeLogistics([
    {
      logistics_channel_id: 91003,
      logistics_channel_name: "Shopee Xpress",
      enabled: false,
    },
    {
      logistics_channel_id: 91006,
      logistics_channel_name: "Expresso Aereo",
      enabled: true,
    },
  ]);

  assert.equal(analysis.spxEnabled, true);
  assert.equal(analysis.spxEligible, false);
  assert.equal(analysis.spxChannel.channelId, "91006");
  assert.deepEqual(analysis.shippingKinds, ["spx"]);
  assert.deepEqual(analysis.shippingChannels, ["Expresso Aereo"]);
});
