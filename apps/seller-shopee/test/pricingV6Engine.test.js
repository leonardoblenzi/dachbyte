"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_PRICING_SETTINGS,
  calculatePrice,
  getFeeRule,
  getEligibleCouponDiscount,
  roundUpToPsychologicalPrice,
} = require("../src/services/PricingV6Engine");
const { _test: pricingRepositoryTest } = require("../src/repositories/pricingV6SqlRepository");
const PricingV6Service = require("../src/services/PricingV6Service");
const pricingRepository = require("../src/repositories/pricingV6SqlRepository");
const { _test: pricingServiceTest } = require("../src/services/PricingV6Service");
const { _test: productSyncTest } = require("../src/repositories/productSyncSqlRepository");
const { _test: priceIncreaseTest } = require("../src/repositories/priceIncreaseSqlRepository");


test("precificacao V6 consulta somente anuncios ativos da Shopee", () => {
  const filters = pricingRepositoryTest.buildProductFilters({ shopId: 123 });

  assert.deepEqual(pricingRepositoryTest.PRICING_ACTIVE_PRODUCT_STATUSES, ["NORMAL", "ACTIVE"]);
  assert.match(
    filters.whereSql,
    /UPPER\(TRIM\(COALESCE\(p\.status, ''\)\)\) IN \('NORMAL', 'ACTIVE'\)/,
  );
});

test("precificacao V6 nao aplica faixa de preco quando ela nao foi informada", () => {
  const filters = pricingRepositoryTest.buildProductFilters({ shopId: 123, q: "pneu" });

  assert.deepEqual(filters.params, [123, "%pneu%"]);
  assert.doesNotMatch(filters.whereSql, /priceMin/);
});
test("considera somente campanhas em andamento como preco promocional vigente", () => {
  assert.deepEqual(pricingRepositoryTest.CURRENT_PRICE_PROMOTION_STATUSES, ["ongoing"]);
});

test("linha do precificador preserva a tag da campanha de brinde ativa", () => {
  const row = pricingRepositoryTest.mapProductRow({
    product_id: 12,
    item_id: "1200",
    model_id: null,
    title: "Mesa",
    cost_cents: 1000,
    current_price: 30,
    gift_campaign_id: "8d4a9b85-7f8b-4ea6-b2f5-2d5d8b9c805a",
    gift_campaign_name: "Brinde setembro",
    gift_campaign_status: "published",
    gift_campaign_min_spend_cents: 19990,
    gift_campaign_provision_cents: 1750,
  });

  assert.equal(row.hasActiveCampaign, false);
  assert.equal(row.giftCampaign.name, "Brinde setembro");
  assert.equal(row.giftCampaign.giftProvisionCents, 1750);
  assert.equal(row.giftCampaign.minSpendCents, 19990);
});

test("mudanca de estado relevante de campanha de brinde invalida o catalogo", async () => {
  const invalidated = [];
  const snapshotRepository = {
    async invalidateAllReusableSnapshots({ shopId }) {
      invalidated.push(shopId);
    },
  };

  assert.equal(await pricingServiceTest.invalidateCatalogForGiftCampaignState({
    shopId: 42,
    status: "published",
    repository: snapshotRepository,
  }), true);
  assert.equal(await pricingServiceTest.invalidateCatalogForGiftCampaignState({
    shopId: 42,
    status: "draft",
    repository: snapshotRepository,
  }), false);
  assert.deepEqual(invalidated, [42]);
});
test("migration do cache V6 cria as chaves de reutilizacao de previa", () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "20260813123000_add_pricing_v6_snapshot_cache_columns",
    "migration.sql",
  ), "utf8");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "requestKey" TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ALTER COLUMN "requestKey" SET NOT NULL/);
});

test("job de precificacao V6 ignora itens que deixaram de estar ativos", () => {
  const items = [
    { productId: 10, modelId: null, itemId: "100" },
    { productId: 11, modelId: "7", itemId: "101" },
  ];

  const result = pricingServiceTest.splitJobItemsByActiveKeys(items, new Set(["10:0"]));

  assert.deepEqual(result.active, [items[0]]);
  assert.deepEqual(result.inactive, [items[1]]);
});

test("reutiliza a previa V6 ate uma atualizacao manual", async () => {
  const snapshots = [];
  const repository = {
    async findReusableSnapshot({ requestKey }) {
      return snapshots.find((snapshot) => snapshot.requestKey === requestKey) || null;
    },
    async invalidateReusableSnapshots({ requestKey }) {
      snapshots.forEach((snapshot) => {
        if (snapshot.requestKey === requestKey) snapshot.invalidatedAt = new Date();
      });
    },
    async createSnapshot(snapshot) {
      snapshots.push({ ...snapshot, created_at: new Date(), result: snapshot.result });
    },
  };
  const request = {
    repository,
    shopId: 7,
    settingsVersion: 3,
    selection: { mode: "keys", keys: ["12:0"] },
    filters: { q: "mesa" },
    createId: () => `snapshot-${snapshots.length + 1}`,
    buildResult: async () => ({ summary: { total: 1 }, items: [{ key: "12:0" }] }),
  };

  const first = await pricingServiceTest.reuseOrCreatePreview(request);
  const reused = await pricingServiceTest.reuseOrCreatePreview(request);
  const refreshed = await pricingServiceTest.reuseOrCreatePreview({ ...request, forceRefresh: true });

  assert.equal(first.reused, false);
  assert.equal(reused.snapshotId, first.snapshotId);
  assert.equal(reused.reused, true);
  assert.notEqual(refreshed.snapshotId, first.snapshotId);
  assert.equal(refreshed.reused, false);
});

test("reutiliza o catalogo completo V6 ate uma atualizacao manual", async () => {
  const snapshots = [];
  let productLoads = 0;
  const repository = {
    async findReusableSnapshot({ requestKey }) {
      return snapshots.find((snapshot) => snapshot.requestKey === requestKey && !snapshot.invalidatedAt) || null;
    },
    async invalidateReusableSnapshots({ requestKey }) {
      snapshots.forEach((snapshot) => {
        if (snapshot.requestKey === requestKey) snapshot.invalidatedAt = new Date();
      });
    },
    async createSnapshot(snapshot) {
      snapshots.push({ ...snapshot, created_at: new Date(), result: snapshot.result });
    },
  };
  const request = {
    repository,
    shopId: 7,
    settings: {
      version: 3,
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 200 }],
    },
    loadRows: async () => {
      productLoads += 1;
      return [{
        key: "12:0",
        productId: 12,
        itemId: "1200",
        modelId: null,
        title: "Produto em cache",
        currentPriceCents: 1000,
        costCents: 500,
        hasActiveCampaign: false,
        giftCampaign: {
          id: "8d4a9b85-7f8b-4ea6-b2f5-2d5d8b9c805a",
          name: "Brinde setembro",
          status: "published",
          minSpendCents: 19990,
          giftProvisionCents: 1750,
          startsAt: "2026-09-10T12:00:00.000Z",
          endsAt: "2026-10-10T12:00:00.000Z",
        },
      }];
    },
    createId: () => `catalog-${snapshots.length + 1}`,
  };

  const first = await pricingServiceTest.getCatalogSnapshotWithRepository(request);
  const reused = await pricingServiceTest.getCatalogSnapshotWithRepository(request);
  const refreshed = await pricingServiceTest.getCatalogSnapshotWithRepository({ ...request, forceRefresh: true });

  assert.equal(productLoads, 2);
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(refreshed.reused, false);
  assert.equal(reused.items[0].title, "Produto em cache");
  assert.equal(reused.items[0].giftCampaign.name, "Brinde setembro");
});

test("a previa selecionada muda quando o catalogo base e atualizado", () => {
  const selection = { mode: "keys", keys: ["12:0"] };
  const first = pricingServiceTest.buildPreviewRequestKey({ selection, filters: {}, catalogSnapshotId: "catalog-1" });
  const refreshed = pricingServiceTest.buildPreviewRequestKey({ selection, filters: {}, catalogSnapshotId: "catalog-2" });

  assert.notEqual(first, refreshed);
});

test("filtro de margem atual negativa retorna apenas produtos com prejuizo atual", () => {
  const filters = pricingServiceTest.normalizeFilters({ negativeCurrentMargin: "1" });
  const rows = pricingServiceTest.filterCatalogRows([
    { key: "negative", currentMarginRate: -0.01, costCents: 100, currentPriceCents: 200 },
    { key: "zero", currentMarginRate: 0, costCents: 100, currentPriceCents: 200 },
    { key: "positive", currentMarginRate: 0.02, costCents: 100, currentPriceCents: 200 },
    { key: "unknown", currentMarginRate: null, costCents: 100, currentPriceCents: 200 },
  ], filters);

  assert.deepEqual(rows.map((row) => row.key), ["negative"]);
});
test("simulador livre calcula o mesmo repasse liquido do motor", async () => {
  const result = await pricingServiceTest.simulateSalePriceWithRepository({
    repository: {
      async getPricingRowByKey() {
        return {
          key: "12:0",
          productId: 12,
          itemId: "1200",
          modelId: null,
          title: "Produto teste",
          sku: "SKU-12",
          costCents: 500,
        };
      },
    },
    shopId: 7,
    key: "12:0",
    salePrice: "9,00",
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 200 }],
    },
    targetMarginRate: 0.1,
  });

  assert.equal(result.salePriceCents, 900);
  assert.equal(result.netPayoutCents, 610);
  assert.equal(result.breakdown.contributionCents, 110);
  assert.equal(result.marginRate, result.breakdown.marginRate);
});

test("simulador livre rejeita preco invalido sem consultar o produto", async () => {
  await assert.rejects(
    () => pricingServiceTest.simulateSalePriceWithRepository({
      repository: {
        async getPricingRowByKey() {
          throw new Error("nao deveria consultar o produto");
        },
      },
      shopId: 7,
      key: "12:0",
      salePrice: "0",
      settings: DEFAULT_PRICING_SETTINGS,
      targetMarginRate: 0.2,
    }),
    (error) => error?.statusCode === 422,
  );
});

test("deduz a aliquota da receita apos cupom no motor V6", () => {
  const settings = {
    ...DEFAULT_PRICING_SETTINGS,
    taxRate: 10,
    coupons: [],
    campaignEnabled: false,
    feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 200 }],
  };

  const withoutTax = calculatePrice({ costCents: 500, targetMarginRate: 0.1, settings: { ...settings, taxRate: 0 } });
  const withTax = calculatePrice({ costCents: 500, targetMarginRate: 0.1, settings });

  assert.ok(withTax.breakdown.taxCents > 0);
  assert.ok(withTax.recommendedPriceCents > withoutTax.recommendedPriceCents);
});

test("precificador nao expoe nem preserva markup e adicional de preco cheio", () => {
  const legacySettings = pricingServiceTest.mapSettings({
    shop_tax_rate: 0,
    config: { fullPriceMarkup: 2.25, fullPriceAdditionCents: 400 },
  });
  const publicSettings = PricingV6Service.publicSettings(legacySettings);
  const updated = pricingServiceTest.mergeSettingsInput(legacySettings, {});

  assert.equal(legacySettings.fullPriceMarkup, 0);
  assert.equal(legacySettings.fullPriceAdditionCents, 0);
  assert.equal(Object.hasOwn(publicSettings, "fullPriceMarkup"), false);
  assert.equal(Object.hasOwn(publicSettings, "fullPriceAdditionCents"), false);
  assert.equal(updated.fullPriceMarkup, 0);
  assert.equal(updated.fullPriceAdditionCents, 0);
});
test("usa a aliquota da loja quando o V6 nao possui uma substituicao", () => {
  const inherited = pricingServiceTest.mapSettings({ shop_tax_rate: 8, config: {} });
  const inheritedFromLegacyNull = pricingServiceTest.mapSettings({ shop_tax_rate: 8, config: { taxRate: null } });
  const overridden = pricingServiceTest.mapSettings({ shop_tax_rate: 8, config: { taxRate: 12 } });

  assert.equal(inherited.taxRate, 0.08);
  assert.equal(inherited.taxRateOverride, null);
  assert.equal(inheritedFromLegacyNull.taxRate, 0.08);
  assert.equal(inheritedFromLegacyNull.taxRateOverride, null);
  assert.equal(overridden.taxRate, 0.12);
  assert.equal(overridden.taxRateOverride, 0.12);
  assert.equal(Object.hasOwn(pricingServiceTest.mergeSettingsInput(inherited, {}), "taxRate"), false);
  assert.equal(Object.hasOwn(pricingServiceTest.mergeSettingsInput(overridden, { taxRate: null }), "taxRate"), false);
  assert.throws(() => pricingServiceTest.normalizeOptionalTaxRate(101), /al[ií]quota/i);
});

test("usa o preco promocional ativo para calcular a margem atual", () => {
  const result = pricingServiceTest.calculateProduct({
    key: "12:0",
    currentPriceCents: 10000,
    activePromotionPriceCents: 8500,
    costCents: 3000,
  }, {
    ...DEFAULT_PRICING_SETTINGS,
    coupons: [],
    campaignEnabled: false,
    feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 200 }],
  });

  assert.equal(result.currentEffectivePriceCents, 8500);
  assert.ok(Math.abs(result.currentDiscountPercent - 0.15) < 0.000001);
  assert.equal(result.currentMarginRate, result.currentBreakdown.marginRate);
});

test("aplica campanha apenas quando o preco promocional e menor que o preco normal", () => {
  assert.equal(
    pricingServiceTest.isPromotionPriceEligible({
      recommendedPriceCents: 8990,
      previousPriceCents: 10000,
    }),
    true,
  );
  assert.equal(
    pricingServiceTest.isPromotionPriceEligible({
      recommendedPriceCents: 10000,
      previousPriceCents: 10000,
    }),
    false,
  );
  assert.equal(
    pricingServiceTest.isPromotionPriceEligible({
      recommendedPriceCents: 10100,
      previousPriceCents: 10000,
    }),
    false,
  );
  assert.equal(
    pricingServiceTest.isPromotionPriceEligible({
      recommendedPriceCents: 8990,
      previousPriceCents: null,
    }),
    false,
  );
});

test("usa somente o preco base retornado pela Shopee na validacao de promocao", () => {
  assert.equal(
    pricingServiceTest.resolveShopeeBasePriceCents({
      price_info: [{ original_price: "514.90", current_price: "499.90", promotion_price: "499.90" }],
    }),
    51490,
  );
  assert.equal(
    pricingServiceTest.resolveShopeeBasePriceCents({ current_price: "499.90", promotion_price: "499.90" }),
    0,
  );
});

test("reconhece anuncio ativo tambem quando o item carrega um plano de aplicacao", () => {
  const result = pricingServiceTest.splitJobItemsByActiveKeys([
    { item: { productId: 12, modelId: null } },
  ], new Set(["12:0"]));
  assert.equal(result.active.length, 1);
  assert.equal(result.inactive.length, 0);
});

test("planeja promocao usando preco base mesmo quando o preco atual ja esta em promocao", () => {
  assert.deepEqual(
    pricingServiceTest.planPromotionApplication({
      recommendedPriceCents: 8990,
      previousPriceCents: 10000,
      activePromotionPriceCents: 8500,
      fullPriceCents: 10500,
    }),
    { kind: "promotion", basePriceCents: 10000 },
  );

  assert.deepEqual(
    pricingServiceTest.planPromotionApplication({
      recommendedPriceCents: 10000,
      previousPriceCents: 9000,
      activePromotionPriceCents: 8500,
      fullPriceCents: 12000,
    }),
    { kind: "base_price_then_promotion", basePriceCents: 12000 },
  );

  assert.deepEqual(
    pricingServiceTest.planPromotionApplication({
      recommendedPriceCents: 10000,
      previousPriceCents: 9000,
      fullPriceCents: 10000,
    }),
    { kind: "invalid", basePriceCents: 0 },
  );
});

test("aceita politica de substituir a promocao atual antes de criar uma nova", () => {
  assert.equal(pricingServiceTest.normalizeConflictPolicy("replace_existing"), "replace_existing");
});

test("separa itens que exigem elevar o preco-base para atingir a margem padrao", () => {
  const filters = pricingServiceTest.normalizeFilters({ requiresPromotionRemoval: "1" });
  const rows = pricingServiceTest.filterCatalogRows([
    { key: "raise-base", costCents: 100, currentPriceCents: 1000, requiresPromotionRemoval: true },
    { key: "keep-promotion", costCents: 100, currentPriceCents: 1000, requiresPromotionRemoval: false },
  ], filters);

  assert.deepEqual(rows.map((row) => row.key), ["raise-base"]);
  assert.equal(
    pricingServiceTest.normalizeConflictPolicy("raise_base_remove_promotions"),
    "raise_base_remove_promotions",
  );
});

test("agrupa variacoes e envia preco promocional em reais para a Shopee", () => {
  const result = pricingServiceTest.buildDiscountItemPayload([
    { item: { itemId: "10", modelId: "101", recommendedPriceCents: 280990 } },
    { item: { itemId: "10", modelId: "102", recommendedPriceCents: 279990 } },
    { item: { itemId: "20", modelId: null, recommendedPriceCents: 4990 } },
  ]);
  assert.deepEqual(result.map(({ payload }) => payload), [
    { item_id: 10, model_list: [
      { model_id: 101, model_promotion_price: 2809.9 },
      { model_id: 102, model_promotion_price: 2799.9 },
    ] },
    { item_id: 20, item_promotion_price: 49.9 },
  ]);
});

test("interpreta erro granular da Shopee como falha do item da campanha", () => {
  const failure = pricingServiceTest.getDiscountItemFailure({
    response: { error_list: [{ item_id: 10, model_id: 0, fail_error: "discount.item_id_repeated", fail_message: "item repeated" }] },
  }, { itemId: "10", modelId: "101" });
  assert.equal(failure, "discount.item_id_repeated: item repeated");
});
test("mantem todos os itens saudaveis selecionados no job, mesmo quando exigem ajuste de preco base", async () => {
  const originals = {
    getSnapshot: pricingRepository.getSnapshot,
    createPricingJob: pricingRepository.createPricingJob,
    getPricingJob: pricingRepository.getPricingJob,
  };
  let created = null;
  pricingRepository.getSnapshot = async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    expires_at: null,
    result: { items: [
      { health: "healthy", recommendedPriceCents: 8990, currentPriceCents: 10000, fullPriceCents: 10500, itemId: "10" },
      { health: "healthy", recommendedPriceCents: 10000, currentPriceCents: 9000, fullPriceCents: 12000, itemId: "11" },
    ] },
  });
  pricingRepository.createPricingJob = async (input) => { created = input; return { id: "11111111-1111-4111-8111-111111111111", created: true }; };
  pricingRepository.getPricingJob = async ({ id }) => ({ id, state: "awaiting_confirmation" });
  try {
    await PricingV6Service.createJob({ shop: { id: 7 }, userId: 11, snapshotId: "22222222-2222-4222-8222-222222222222", conflictPolicy: "replace_existing" });
    assert.equal(created.items.length, 2);
    assert.equal(created.conflictPolicy, "replace_existing");
  } finally {
    Object.assign(pricingRepository, originals);
  }
});

test("reutiliza o job existente quando a mesma previa e politica ja foram solicitadas", async () => {
  const originals = {
    getSnapshot: pricingRepository.getSnapshot,
    createPricingJob: pricingRepository.createPricingJob,
    getPricingJob: pricingRepository.getPricingJob,
  };
  const existingJobId = "11111111-1111-4111-8111-111111111111";
  let requestedJobId = null;

  pricingRepository.getSnapshot = async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    expires_at: null,
    result: {
      items: [{
        health: "healthy",
        recommendedPriceCents: 8990,
        currentPriceCents: 10000,
        itemId: "10",
      }],
    },
  });
  pricingRepository.createPricingJob = async () => ({ id: existingJobId, created: false });
  pricingRepository.getPricingJob = async ({ id }) => {
    requestedJobId = id;
    return { id, state: "awaiting_confirmation" };
  };

  try {
    const job = await PricingV6Service.createJob({
      shop: { id: 7 },
      userId: 11,
      snapshotId: "22222222-2222-4222-8222-222222222222",
      conflictPolicy: "skip",
    });

    assert.equal(job.id, existingJobId);
    assert.equal(requestedJobId, existingJobId);
  } finally {
    Object.assign(pricingRepository, originals);
  }
});

test("preserva centavos do preco Shopee antes de converter para o Motor V6", () => {
  assert.equal(productSyncTest.toMoneyOrNull("514.90"), 514.9);
  assert.equal(priceIncreaseTest.toPriceAmountOrNull("514.90"), 514.9);
  assert.equal(pricingRepositoryTest.toPriceCents(514.9), 51490);
});

test("migration de preco preserva duas casas decimais e recupera eventos Shopee", () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "20260811150000_preserve_product_price_precision",
    "migration.sql",
  ), "utf8");

  assert.match(migration, /ALTER COLUMN "priceMin" TYPE NUMERIC\(14, 2\)/);
  assert.match(migration, /ALTER COLUMN price TYPE NUMERIC\(14, 2\)/);
  assert.match(migration, /ProductPriceUpdateEvent/);
});

test("aplica a matriz de taxas nos limites das faixas", () => {
  assert.deepEqual(getFeeRule(799), { commissionRate: 0.5, fixedFeeCents: 0 });
  assert.deepEqual(getFeeRule(800), { commissionRate: 0.2, fixedFeeCents: 400 });
  assert.deepEqual(getFeeRule(8000), { commissionRate: 0.14, fixedFeeCents: 1600 });
  assert.deepEqual(getFeeRule(10000), { commissionRate: 0.14, fixedFeeCents: 2000 });
  assert.deepEqual(getFeeRule(20000), { commissionRate: 0.14, fixedFeeCents: 2600 });
});

test("aceita matriz de taxas versionada nas configuracoes", () => {
  assert.deepEqual(
    getFeeRule(1000, [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 50 }]),
    { commissionRate: 0.1, fixedFeeCents: 50 },
  );
});

test("normaliza porcentagens recebidas como percentual ou fracao", () => {
  const result = calculatePrice({
    costCents: 1000,
    targetMarginRate: 20,
    settings: { ...DEFAULT_PRICING_SETTINGS, coupons: [], campaignEnabled: false },
  });
  assert.equal(result.targetMarginRate, 0.2);
});

test("considera somente o maior cupom elegivel para o preco proposto", () => {
  const coupons = [
    { percent: 2, minimumCents: 5000, capCents: 1000, active: true },
    { percent: 3, minimumCents: 49990, capCents: 2100, active: true },
    { percent: 7, minimumCents: 69900, capCents: 4900, active: true },
  ];

  assert.equal(getEligibleCouponDiscount(49989, coupons).discountCents, 1000);
  assert.equal(getEligibleCouponDiscount(49990, coupons).discountCents, 1500);
  assert.equal(getEligibleCouponDiscount(69900, coupons).discountCents, 4893);
});

test("arredonda apenas para cima usando o acabamento configurado", () => {
  assert.equal(roundUpToPsychologicalPrice(1001, [90, 99, 49]), 1049);
  assert.equal(roundUpToPsychologicalPrice(1049, [90, 99, 49]), 1049);
  assert.equal(roundUpToPsychologicalPrice(1091, [90, 99, 49]), 1099);
});

test("encontra o menor preco saudavel e exibe uma segunda alternativa", () => {
  const result = calculatePrice({
    costCents: 10000,
    logisticsCostCents: 0,
    otherFixedCostCents: 0,
    targetMarginRate: 0.2,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [90, 99, 49],
    },
  });

  assert.equal(result.status, "healthy");
  assert.ok(result.recommendedPriceCents >= 10000);
  assert.ok(result.breakdown.marginRate >= 0.2);
  assert.ok(result.secondBestPriceCents > result.recommendedPriceCents);
  assert.ok(result.breakdown.totalFeesCents > 0);
});

test("prefere o menor preco elegivel quando uma faixa deixa mais repasse liquido", () => {
  const result = calculatePrice({
    costCents: 500,
    targetMarginRate: 0.1,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      feeRules: [
        { maxCents: 900, commissionRate: 0.1, fixedFeeCents: 200 },
        { maxCents: null, commissionRate: 0.1, fixedFeeCents: 300 },
      ],
    },
  });

  assert.equal(result.recommendedPriceCents, 900);
  assert.equal(result.breakdown.contributionCents, 110);
  assert.equal(result.netPayoutCents, 610);
});

test("encontra a menor faixa saudavel depois de uma mudanca de taxa fixa", () => {
  const result = calculatePrice({
    costCents: 100,
    targetMarginRate: 0.1,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      feeRules: [
        { maxCents: 800, commissionRate: 0.15, fixedFeeCents: 600 },
        { maxCents: null, commissionRate: 0.15, fixedFeeCents: 1500 },
      ],
    },
  });

  assert.equal(result.recommendedPriceCents, 2200);
  assert.equal(result.breakdown.contributionCents, 270);
});

test("preserva o desconto PIX como preco percebido, sem reduzi-lo da margem do vendedor", () => {
  const result = calculatePrice({
    costCents: 10000,
    targetMarginRate: 0.2,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      pixDiscountRules: [{ minCents: 8000, maxCents: 49999, rate: 0.05 }],
    },
  });

  assert.ok(result.pixPriceCents < result.recommendedPriceCents);
  assert.equal(
    result.breakdown.contributionCents,
    result.recommendedPriceCents - result.breakdown.totalFeesCents - 10000,
  );
});