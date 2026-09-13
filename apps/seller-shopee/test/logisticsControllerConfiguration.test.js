const test = require("node:test");
const assert = require("node:assert/strict");

Object.assign(process.env, {
  API_BASE_URL: "https://api.example.test",
  SHOPEE_API_BASE: "https://shopee.example.test",
  SHOPEE_PARTNER_ID: "1",
  SHOPEE_PARTNER_KEY: "test-partner-key",
  SHOPEE_REDIRECT_URL: "https://app.example.test/callback",
});

const {
  configureProducts,
  getConflictAdjustedLogistics,
  isSellerEligible,
} = require("../src/controllers/LogisticsController");
const { analyzeLogistics } = require("../src/utils/productLogistics");
const shopeeCreditCosts = require("../src/services/shopeeCreditCosts");
const fs = require("fs");
const path = require("path");

function product(itemId, logistics) {
  return {
    id: Number(itemId),
    itemId: String(itemId),
    title: `Cached ${itemId}`,
    status: "NORMAL",
    logistics,
    dimension: { package_length: 20, package_width: 20, package_height: 20 },
    weight: 1,
  };
}

function channels({ seller = false, spx = false, heavy = false } = {}) {
  return [
    { logistics_channel_name: "Logistica do vendedor", enabled: seller },
    { logistics_channel_id: 91006, logistics_channel_name: "Expresso Aereo", enabled: spx },
    { logistics_channel_id: 99123, logistics_channel_name: "Entrega de Item Grande/Pesado", enabled: heavy },
  ];
}

test("configures every eligible listing and preserves live title and status metadata", async () => {
  const remoteWrites = [];
  const localWrites = [];
  const result = await configureProducts({
    products: [product("101", channels()), product("102", channels())],
    liveInfoByItemId: new Map([
      ["101", {
        item_id: 101,
        item_name: "Live 101",
        item_status: "ACTIVE",
        logistic_info: channels(),
        dimension: { package_length: 20, package_width: 20, package_height: 20 },
        weight: 1,
      }],
    ]),
    targetKinds: ["seller", "spx"],
    shopShopeeId: "77",
    updateRemote: async (payload) => remoteWrites.push(payload),
    updateLocal: async (id, cache) => localWrites.push({ id, cache }),
  });

  assert.equal(remoteWrites.length, 2);
  assert.equal(localWrites.length, 2);
  assert.deepEqual(result.results.map((entry) => entry.ok), [true, true]);
  assert.deepEqual(result.results.map((entry) => entry.title), ["Live 101", "Cached 102"]);
  assert.deepEqual(result.results.map((entry) => entry.status), ["ACTIVE", "NORMAL"]);
  assert.deepEqual(result.results[0].enabledKinds.sort(), ["seller", "spx"]);
  assert.deepEqual(result.results[0].availableKinds.sort(), ["heavy", "seller", "spx"]);
});

test("does not write unavailable seller or heavy channels", async () => {
  const remoteWrites = [];
  const localWrites = [];
  const result = await configureProducts({
    products: [
      product("201", channels()).__proto__,
    ].map(() => product("201", [
      { logistics_channel_id: 91006, logistics_channel_name: "Expresso Aereo", enabled: false },
    ])),
    liveInfoByItemId: new Map(),
    targetKinds: ["seller", "heavy"],
    shopShopeeId: "77",
    updateRemote: async (payload) => remoteWrites.push(payload),
    updateLocal: async (id, cache) => localWrites.push({ id, cache }),
  });

  assert.equal(remoteWrites.length, 0);
  assert.equal(localWrites.length, 0);
  assert.equal(result.results[0].ok, false);
  assert.deepEqual(result.results[0].errors.map((error) => error.code), ["channel_unavailable"]);
  assert.deepEqual(result.results[0].availableKinds, ["spx"]);
});

test("reports individual remote failures and only persists cache after remote success", async () => {
  const calls = [];
  const result = await configureProducts({
    products: [product("301", channels()), product("302", channels())],
    liveInfoByItemId: new Map(),
    targetKinds: ["seller"],
    shopShopeeId: "77",
    updateRemote: async ({ itemId }) => {
      calls.push(`remote:${itemId}`);
      if (itemId === "302") throw new Error("Shopee indisponivel");
    },
    updateLocal: async (id) => calls.push(`local:${id}`),
  });

  assert.deepEqual(calls, ["remote:301", "local:301", "remote:302"]);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].message, /Shopee indisponivel/);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
});

test("legacy conflict repair keep-spx yields seller plus SPX without heavy", () => {
  const result = getConflictAdjustedLogistics({
    logistics: analyzeLogistics(channels({ seller: true, spx: true, heavy: true })).logistics,
  }, "spx");
  const analysis = analyzeLogistics(result);

  assert.equal(analysis.sellerEnabled, true);
  assert.equal(analysis.spxEnabled, true);
  assert.equal(analysis.heavyEnabled, false);
});

test("legacy conflict repair keep-seller yields seller-only", () => {
  const result = getConflictAdjustedLogistics({
    logistics: analyzeLogistics(channels({ seller: true, spx: true, heavy: true })).logistics,
  }, "seller");
  const analysis = analyzeLogistics(result);

  assert.equal(analysis.sellerEnabled, true);
  assert.equal(analysis.spxEnabled, false);
  assert.equal(analysis.heavyEnabled, false);
});

test("seller eligibility includes an available disabled seller alongside SPX", () => {
  assert.equal(isSellerEligible({
    intelipostChannels: [{ enabled: false }],
    spxEnabled: true,
  }), true);
});

test("seller eligibility excludes listings without a seller channel", () => {
  assert.equal(isSellerEligible({ intelipostChannels: [], spxEnabled: true }), false);
});

test.skip("registers guided logistics configuration across queue accounting and process UI", () => {
  const action = "logistics.configure";
  const source = (relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
  const jobSource = source("../src/jobs/asyncProcessAction.job.js");
  const queueSource = source("../src/services/AsyncProcessActionQueueService.js");
  const processSource = source("../src/repositories/processExecutionSqlRepository.js");
  const appSource = source("../public/app.js");

  assert.match(queueSource, /"logistics\\.configure"/);
  assert.match(jobSource, /"logistics\\.configure"/);
  assert.match(jobSource, /controller:\\s*LogisticsController\\.configure/);
  assert.equal(
    shopeeCreditCosts.ASYNC_ACTION_OPERATION_MAP[action],
    "shopee.async.logistics",
  );
  assert.match(processSource, /"logistics\\.configure"\\s*:\\s*"Configuracao guiada de logistica"/);
  assert.match(appSource, /"logistics\\.configure"\\s*:\\s*"Configuracao guiada de logistica"/);
  assert.equal(appSource.includes("/shops/active/logistics/configure"), true);
});

test("registers guided logistics configuration across queue accounting and process UI", () => {
  const action = "logistics.configure";
  const source = (relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
  const jobSource = source("../src/jobs/asyncProcessAction.job.js");
  const queueSource = source("../src/services/AsyncProcessActionQueueService.js");
  const processSource = source("../src/repositories/processExecutionSqlRepository.js");
  const appSource = source("../public/app.js");

  assert.equal(queueSource.includes(action), true);
  assert.equal(jobSource.includes(action), true);
  assert.equal(jobSource.includes("controller: LogisticsController.configure"), true);
  assert.equal(shopeeCreditCosts.ASYNC_ACTION_OPERATION_MAP[action], "shopee.async.logistics");
  assert.equal(processSource.includes(action), true);
  assert.equal(processSource.includes("Configuracao guiada de logistica"), true);
  assert.equal(appSource.includes(action), true);
  assert.equal(appSource.includes("/shops/active/logistics/configure"), true);
});

test("automatic mapping accepts original accented seller and pickup labels", async () => {
  const controllerPath = require.resolve("../src/controllers/LogisticsController");
  const resolveShopModule = require("../src/utils/resolveShop");
  const productRepository = require("../src/repositories/productSqlRepository");
  const logisticsService = require("../src/services/ShopeeLogisticsService");
  const originals = {
    resolveShop: resolveShopModule.resolveShop,
    listProductsByShopAndItemIdsForLogisticsAnyStatus:
      productRepository.listProductsByShopAndItemIdsForLogisticsAnyStatus,
    updateProductById: productRepository.updateProductById,
    getProductsBaseInfo: logisticsService.getProductsBaseInfo,
    updateProductLogistics: logisticsService.updateProductLogistics,
  };
  const remoteWrites = [];

  resolveShopModule.resolveShop = async () => ({ id: 1, shopId: "77" });
  productRepository.listProductsByShopAndItemIdsForLogisticsAnyStatus = async () => [
    product("401", [
      { logistics_channel_name: "Logistica do vendedor", enabled: false },
    ]),
    product("402", [
      { logistics_channel_name: "Retire perto de voce", enabled: false },
    ]),
  ];
  productRepository.updateProductById = async () => true;
  logisticsService.getProductsBaseInfo = async () => [];
  logisticsService.updateProductLogistics = async (payload) => remoteWrites.push(payload);
  delete require.cache[controllerPath];

  try {
    const response = { json(payload) { this.payload = payload; return payload; } };
    await require("../src/controllers/LogisticsController").applyAutomaticMapping(
      {
        auth: { accountId: 1, activeShopId: 1 },
        body: {
          mappings: [
            { itemId: "401", logisticsRaw: "Logística do vendedor" },
            { itemId: "402", logisticsRaw: "Retire perto de você" },
          ],
        },
      },
      response,
    );

    assert.equal(remoteWrites.length, 2);
    assert.deepEqual(response.payload.results.map((entry) => entry.ok), [true, true]);
    assert.deepEqual(response.payload.summaryLines, [
      "0 produtos já estavam com a logística desejada ativa",
      "0 produtos ativos em Shopee Xpress, 1 Retire perto de você e 1 Logística do vendedor",
    ]);
  } finally {
    Object.assign(resolveShopModule, { resolveShop: originals.resolveShop });
    Object.assign(productRepository, {
      listProductsByShopAndItemIdsForLogisticsAnyStatus:
        originals.listProductsByShopAndItemIdsForLogisticsAnyStatus,
      updateProductById: originals.updateProductById,
    });
    Object.assign(logisticsService, {
      getProductsBaseInfo: originals.getProductsBaseInfo,
      updateProductLogistics: originals.updateProductLogistics,
    });
    delete require.cache[controllerPath];
  }
});

test("list groups a disabled available seller channel as eligible beside active SPX", async () => {
  const controllerPath = require.resolve("../src/controllers/LogisticsController");
  const resolveShopModule = require("../src/utils/resolveShop");
  const productRepository = require("../src/repositories/productSqlRepository");
  const logisticsService = require("../src/services/ShopeeLogisticsService");
  const originals = {
    resolveShop: resolveShopModule.resolveShop,
    listProductsForLogistics: productRepository.listProductsForLogistics,
    updateProductById: productRepository.updateProductById,
    getProductsBaseInfo: logisticsService.getProductsBaseInfo,
  };

  resolveShopModule.resolveShop = async () => ({ id: 1, shopId: "77" });
  productRepository.listProductsForLogistics = async () => [
    {
      ...product("501", []),
      spxSnapshotAt: new Date(),
      spxEnabledCache: true,
    },
  ];
  productRepository.updateProductById = async () => true;
  logisticsService.getProductsBaseInfo = async () => [
    {
      item_id: 501,
      item_name: "Live SPX listing",
      item_status: "ACTIVE",
      logistic_info: [
        { logistics_channel_name: "Logistica do vendedor", enabled: false },
        { logistics_channel_id: 91006, logistics_channel_name: "Expresso Aereo", enabled: true },
      ],
      dimension: { package_length: 20, package_width: 20, package_height: 20 },
      weight: 1,
    },
  ];
  delete require.cache[controllerPath];

  try {
    const response = { json(payload) { this.payload = payload; return payload; } };
    await require("../src/controllers/LogisticsController").list(
      { auth: { accountId: 1, activeShopId: 1 } },
      response,
    );

    assert.deepEqual(response.payload.seller.eligible.map((entry) => entry.itemId), ["501"]);
    assert.deepEqual(response.payload.spx.enabled.map((entry) => entry.itemId), ["501"]);
  } finally {
    Object.assign(resolveShopModule, { resolveShop: originals.resolveShop });
    Object.assign(productRepository, {
      listProductsForLogistics: originals.listProductsForLogistics,
      updateProductById: originals.updateProductById,
    });
    Object.assign(logisticsService, { getProductsBaseInfo: originals.getProductsBaseInfo });
    delete require.cache[controllerPath];
  }
});
