"use strict";

const crypto = require("crypto");
const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");
const ShopeeProductWriteService = require("./ShopeeProductWriteService");
const ShopeeProductService = require("./ShopeeProductService");
const {
  DEFAULT_PRICING_SETTINGS,
  buildBreakdown,
  calculatePrice,
  normalizeSettings,
} = require("./PricingV6Engine");
const repository = require("../repositories/pricingV6SqlRepository");
const { calculateV7Price, simulateV7SalePrice } = require("./PricingV7Engine");
const calibrationRepository = require("../repositories/pricingV7SqlRepository");
const { collectRoasMetricsForRange } = require("./AdsRoasMetricsService");
const { query } = require("../config/postgres");

const APPLY_START_DELAY_MS = 65 * 60 * 1000;
const APPLY_DURATION_MS = 179 * 24 * 60 * 60 * 1000;
const JOB_CHUNK_SIZE = 1000;
const API_BATCH_SIZE = 50;
const CONFLICT_POLICIES = new Set(["skip", "replace_upcoming", "replace_existing", "raise_base_remove_promotions"]);
const GIFT_CAMPAIGN_CATALOG_INVALIDATION_STATES = new Set(["published", "cancelled", "ended", "partial_failed"]);
// Bump this only when the persisted catalog shape or eligibility changes.
// It rebuilds the catalog once after a deployed correction without reintroducing TTLs.
const FULL_CATALOG_SELECTION = Object.freeze({ mode: "all", excludedKeys: [], filters: {}, catalogRevision: 4 });

function asCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function parseShopeeMoneyCents(value) {
  if (value == null || value === "") return 0;
  const normalized = typeof value === "string" ? value.trim().replace(",", ".") : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function collectShopeePriceSources(source) {
  const root = source && typeof source === "object" ? source : {};
  const priceInfo = Array.isArray(root.price_info)
    ? root.price_info
    : Array.isArray(root.priceInfo)
      ? root.priceInfo
      : [root.price_info || root.priceInfo].filter((entry) => entry && typeof entry === "object");
  return [root, ...priceInfo].filter((entry, index, list) => entry && typeof entry === "object" && list.indexOf(entry) === index);
}

function resolveShopeeBasePriceCents(source) {
  const baseKeys = ["original_price", "originalPrice", "inflated_price_of_original_price", "local_price", "model_original_price", "item_original_price", "price_before_discount", "input_normal_price", "normal_price", "list_price"];
  for (const entry of collectShopeePriceSources(source)) {
    for (const key of baseKeys) {
      const cents = parseShopeeMoneyCents(entry[key]);
      if (cents > 0) return cents;
    }
  }
  return 0;
}

function resolveShopeePromotionPriceCents(source, basePriceCents) {
  const promotionKeys = ["promotion_price", "promo_price", "discount_price", "inflated_price_of_current_price", "local_promotion_price", "model_promotion_price", "item_promotion_price", "price_after_discount"];
  for (const entry of collectShopeePriceSources(source)) {
    for (const key of promotionKeys) {
      const cents = parseShopeeMoneyCents(entry[key]);
      if (cents > 0 && cents < basePriceCents) return cents;
    }
  }
  for (const entry of collectShopeePriceSources(source)) {
    const current = parseShopeeMoneyCents(entry.current_price ?? entry.currentPrice);
    if (current > 0 && current < basePriceCents) return current;
  }
  return 0;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const rows = Array.isArray(items) ? items : [];
  const result = new Array(rows.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await worker(rows[index]);
    }
  });
  await Promise.all(runners);
  return result;
}

async function fetchLivePriceValidation(shop, items) {
  const targets = Array.isArray(items) ? items : [];
  const itemIds = Array.from(new Set(targets.map((item) => String(item?.itemId || "").trim()).filter(Boolean)));
  const validations = new Map();
  for (const batch of chunks(itemIds, 50)) {
    try {
      const payload = await ShopeeProductService.getItemBaseInfo({ shopId: String(shop.shopId), itemIdList: batch });
      const rows = Array.isArray(payload?.response?.item_list) ? payload.response.item_list : [];
      for (const row of rows) {
        const itemId = String(row?.item_id || row?.itemId || "").trim();
        if (!itemId) continue;
        const basePriceCents = resolveShopeeBasePriceCents(row);
        validations.set(`${itemId}:0`, {
          basePriceCents,
          promotionPriceCents: resolveShopeePromotionPriceCents(row, basePriceCents),
          source: "shopee_item_base_info",
        });
      }
    } catch (_error) {
      // Sem preço-base ao vivo, o item é mantido fora da aplicação por segurança.
    }
  }

  const modelItemIds = Array.from(new Set(targets.filter((item) => item?.modelId != null && String(item.modelId) !== "" && String(item.modelId) !== "0").map((item) => String(item.itemId))));
  const modelResponses = await mapWithConcurrency(modelItemIds, 4, async (itemId) => {
    try {
      const payload = await ShopeeProductService.getModelList({ shopId: String(shop.shopId), itemId });
      return { itemId, models: Array.isArray(payload?.response?.model) ? payload.response.model : [] };
    } catch (_error) {
      return { itemId, models: [] };
    }
  });
  for (const response of modelResponses) {
    for (const model of response.models) {
      const modelId = String(model?.model_id || model?.modelId || "").trim();
      if (!modelId) continue;
      const basePriceCents = resolveShopeeBasePriceCents(model);
      validations.set(`${response.itemId}:${modelId}`, {
        basePriceCents,
        promotionPriceCents: resolveShopeePromotionPriceCents(model, basePriceCents),
        source: "shopee_model_list",
      });
    }
  }
  return validations;
}
async function refreshCatalogPrices({ shop }) {
  const rows = await repository.listPricingProducts({ shopId: shop.id });
  if (!rows.length) return { total: 0, updated: 0, unavailable: 0 };

  const livePrices = await fetchLivePriceValidation(shop, rows);
  const modelUpdates = [];
  const itemUpdates = [];
  const affectedProductIds = new Set();
  let unavailable = 0;

  for (const row of rows) {
    const modelKey = row.modelId == null || String(row.modelId) === "" ? 0 : row.modelId;
    const live = livePrices.get(String(row.itemId) + ":" + String(modelKey));
    const basePriceCents = Number(live?.basePriceCents || 0);
    if (!basePriceCents) {
      unavailable += 1;
      continue;
    }
    const price = toShopeePrice(basePriceCents);
    affectedProductIds.add(Number(row.productId));
    if (row.modelId != null && String(row.modelId) !== "") {
      modelUpdates.push([Number(row.productId), String(row.modelId), price]);
    } else {
      itemUpdates.push([Number(row.productId), price]);
    }
  }

  for (const batch of chunks(modelUpdates, 200)) {
    const params = [];
    const values = batch.map((entry, index) => {
      const base = index * 3;
      params.push(entry[0], entry[1], entry[2]);
      return "($" + (base + 1) + "::integer, $" + (base + 2) + "::bigint, $" + (base + 3) + "::numeric)";
    }).join(", ");
    await query(
      'UPDATE "ProductModel" pm SET price = source.price FROM (VALUES ' + values + ') AS source(product_id, model_id, price) WHERE pm."productId" = source.product_id AND pm."modelId" = source.model_id',
      params,
    );
  }

  for (const batch of chunks(itemUpdates, 200)) {
    const params = [];
    const values = batch.map((entry, index) => {
      const base = index * 2;
      params.push(entry[0], entry[1]);
      return "($" + (base + 1) + "::integer, $" + (base + 2) + "::numeric)";
    }).join(", ");
    await query(
      'UPDATE "Product" p SET "priceMin" = source.price, "priceMax" = source.price, "updatedAt" = NOW() FROM (VALUES ' + values + ') AS source(product_id, price) WHERE p.id = source.product_id',
      params,
    );
  }

  const productIds = [...affectedProductIds];
  if (productIds.length && modelUpdates.length) {
    await query(
      'UPDATE "Product" p SET "priceMin" = price_range.min_price, "priceMax" = price_range.max_price, "updatedAt" = NOW() FROM (SELECT "productId", MIN(price) AS min_price, MAX(price) AS max_price FROM "ProductModel" WHERE "productId" = ANY($1::integer[]) AND price IS NOT NULL GROUP BY "productId") AS price_range WHERE p.id = price_range."productId"',
      [productIds],
    );
  }

  return { total: rows.length, updated: modelUpdates.length + itemUpdates.length, unavailable };
}
function planPromotionApplication(item) {
  const promotionPriceCents = asCents(item?.recommendedPriceCents);
  const currentBasePriceCents = asCents(item?.previousPriceCents ?? item?.currentPriceCents);
  if (!promotionPriceCents) return { kind: "invalid", basePriceCents: 0 };
  if (currentBasePriceCents > promotionPriceCents) {
    return { kind: "promotion", basePriceCents: currentBasePriceCents };
  }
  const calculatedBasePriceCents = asCents(item?.fullPriceCents);
  if (calculatedBasePriceCents > promotionPriceCents) {
    return { kind: "base_price_then_promotion", basePriceCents: calculatedBasePriceCents };
  }
  return { kind: "invalid", basePriceCents: 0 };
}

function isPromotionPriceEligible(item) {
  return planPromotionApplication(item).kind !== "invalid";
}

function toShopeePrice(cents) {
  return Number((asCents(cents) / 100).toFixed(2));
}

function asRate(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number > 1 ? number / 100 : Math.max(0, number);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeOptionalTaxRate(value) {
  if (value == null || String(value).trim() === "") return null;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
    const error = new Error("A aliquota deve estar entre 0 e 100%.");
    error.statusCode = 422;
    throw error;
  }
  return raw > 1 ? raw / 100 : raw;
}

function mapSettings(row) {
  const persistedConfig = parseJson(row?.config, {});
  const taxRateOverride = hasOwn(persistedConfig, "taxRate")
    ? normalizeOptionalTaxRate(persistedConfig.taxRate)
    : null;
  const config = normalizeSettings({
    ...DEFAULT_PRICING_SETTINGS,
    ...persistedConfig,
    taxRate: taxRateOverride ?? row?.shop_tax_rate ?? DEFAULT_PRICING_SETTINGS.taxRate,
    fullPriceMarkup: 0,
    fullPriceAdditionCents: 0,
  });
  return {
    version: Number(row?.version || 1),
    applicationEnabled: Boolean(row?.application_enabled),
    engineMode: ["SAFE", "CALIBRATED", "HYBRID"].includes(String(persistedConfig.engineMode || "").toUpperCase()) ? String(persistedConfig.engineMode).toUpperCase() : "HYBRID",
    confidenceMode: String(persistedConfig.confidenceMode || "AUTO").toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO",
    manualAlpha: Math.max(0, Math.min(1, asRate(persistedConfig.manualAlpha, 0))),
    minQuality: Math.max(0, Math.min(1, asRate(persistedConfig.minQuality, 0.75))),
    calibrationWindowDays: Math.max(30, Math.min(365, Math.round(Number(persistedConfig.calibrationWindowDays || 180)))),
    updatedAt: row?.updated_at || null,
    taxRateOverride,
    ...config,
  };
}

function publicSettings(settings) {
  return {
    version: settings.version,
    applicationEnabled: settings.applicationEnabled,
    updatedAt: settings.updatedAt || null,
    targetMarginRate: settings.targetMarginRate,
    campaignEnabled: settings.campaignEnabled,
    campaignRate: settings.campaignRate,
    variableCostRate: settings.variableCostRate,
    taxRate: settings.taxRate,
    taxRateOverride: settings.taxRateOverride ?? null,
    psychologicalEndings: settings.psychologicalEndings,
    feeRules: settings.feeRules,
    engineMode: settings.engineMode,
    confidenceMode: settings.confidenceMode,
    manualAlpha: settings.manualAlpha,
    minQuality: settings.minQuality,
    calibrationWindowDays: settings.calibrationWindowDays,
    coupons: settings.coupons,
    pixDiscountRules: settings.pixDiscountRules,
  };
}

async function getSettings(shopId) {
  return mapSettings(await repository.getPricingSettings(shopId));
}

function mergeSettingsInput(current, input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const taxRateOverride = hasOwn(source, "taxRate")
    ? normalizeOptionalTaxRate(source.taxRate)
    : (current.taxRateOverride ?? null);
  const merged = normalizeSettings({
    targetMarginRate: source.targetMarginRate ?? current.targetMarginRate,
    campaignEnabled: source.campaignEnabled ?? current.campaignEnabled,
    campaignRate: source.campaignRate ?? current.campaignRate,
    variableCostRate: source.variableCostRate ?? current.variableCostRate,
    taxRate: taxRateOverride ?? 0,
    fullPriceMarkup: 0,
    fullPriceAdditionCents: 0,
    psychologicalEndings: source.psychologicalEndings ?? current.psychologicalEndings,
    feeRules: source.feeRules ?? current.feeRules,
    coupons: source.coupons ?? current.coupons,
    pixDiscountRules: source.pixDiscountRules ?? current.pixDiscountRules,
  });
  merged.engineMode = ["SAFE", "CALIBRATED", "HYBRID"].includes(String(source.engineMode ?? current.engineMode).toUpperCase()) ? String(source.engineMode ?? current.engineMode).toUpperCase() : "HYBRID";
  merged.confidenceMode = String(source.confidenceMode ?? current.confidenceMode).toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO";
  merged.manualAlpha = Math.max(0, Math.min(1, asRate(source.manualAlpha ?? current.manualAlpha, 0)));
  merged.minQuality = Math.max(0, Math.min(1, asRate(source.minQuality ?? current.minQuality, 0.75)));
  merged.calibrationWindowDays = Math.max(30, Math.min(365, Math.round(Number(source.calibrationWindowDays ?? current.calibrationWindowDays ?? 180))));
  if (taxRateOverride == null) delete merged.taxRate;
  return merged;
}

async function saveSettings({ shopId, userId, input }) {
  const current = await getSettings(shopId);
  const config = mergeSettingsInput(current, input);
  const applicationEnabled = input?.applicationEnabled === undefined
    ? current.applicationEnabled
    : Boolean(input.applicationEnabled);
  await repository.upsertPricingSettings({ shopId, config, applicationEnabled, userId });
  return publicSettings(await getSettings(shopId));
}

function calculateProduct(row, settings, calibration) {
  const calculation = calculatePrice({
    costCents: row.costCents,
    logisticsCostCents: 0,
    otherFixedCostCents: 0,
    targetMarginRate: settings.targetMarginRate,
    settings,
  });
  const v7 = calculateV7Price({
    costCents: row.costCents,
    logisticsCostCents: 0,
    otherFixedCostCents: 0,
    targetMarginRate: settings.targetMarginRate,
    settings,
    calibration,
  });
  const hasCost = asCents(row.costCents) > 0;
  const currentPriceCents = asCents(row.currentPriceCents);
  const activePromotionPriceCents = asCents(row.activePromotionPriceCents);
  const currentEffectivePriceCents = activePromotionPriceCents > 0 && activePromotionPriceCents < currentPriceCents
    ? activePromotionPriceCents
    : currentPriceCents;
  const currentBreakdown = currentEffectivePriceCents > 0
    ? buildBreakdown({
      priceCents: currentEffectivePriceCents,
      costCents: row.costCents,
      logisticsCostCents: 0,
      otherFixedCostCents: 0,
      settings,
    })
    : null;
  const health = !hasCost ? "missing_cost" : v7.status;
  const marginRate = v7.selected?.marginRate ?? calculation.breakdown?.marginRate ?? null;
  const hasMarginAlert = health !== "healthy" || marginRate == null || marginRate + 0.000001 < settings.targetMarginRate;
  const recommendedPriceCents = v7.selected?.priceCents ?? calculation.recommendedPriceCents;
  const requiresPromotionRemoval = currentPriceCents > 0 && asCents(recommendedPriceCents) > currentPriceCents;
  return {
    ...row,
    health,
    hasMarginAlert,
    marginRate,
    currentEffectivePriceCents,
    currentDiscountPercent: currentPriceCents > 0 && currentEffectivePriceCents < currentPriceCents
      ? Math.max(0, 1 - currentEffectivePriceCents / currentPriceCents)
      : 0,
    currentMarginRate: currentBreakdown?.marginRate ?? null,
    currentNetPayoutCents: currentBreakdown
      ? currentBreakdown.revenueAfterCouponCents - currentBreakdown.totalFeesCents
      : null,
    currentBreakdown,
    targetMarginRate: settings.targetMarginRate,
    recommendedPriceCents,
    requiresPromotionRemoval,
    secondBestPriceCents: calculation.secondBestPriceCents,
    fullPriceCents: calculation.fullPriceCents,
    pixPriceCents: calculation.pixPriceCents,
    promotionPercent: calculation.promotionPercent,
    breakdown: v7.selected?.breakdown ?? calculation.breakdown,
    engineVersion: "V7",
    selectedMode: v7.selected?.mode || "SAFE",
    safePriceCents: v7.safe?.priceCents ?? null,
    calibratedPriceCents: v7.calibrated?.priceCents ?? null,
    hybridPriceCents: v7.hybrid?.priceCents ?? null,
    calibration: v7.calibration,
    pricingWarnings: v7.warnings || [],
  };
}

function normalizePage(value, fallback = 1) {
  const page = Math.trunc(Number(value));
  return Number.isFinite(page) && page > 0 ? page : fallback;
}

function normalizePageSize(value, fallback = 50) {
  const size = Math.trunc(Number(value));
  return Number.isFinite(size) ? Math.min(200, Math.max(1, size)) : fallback;
}

function normalizeFilters(filters = {}) {
  const requestedMarginRate = filters?.targetMarginRate == null || filters?.targetMarginRate === ""
    ? null
    : asRate(filters.targetMarginRate, -1);
  return {
    q: String(filters?.q || "").trim().slice(0, 160),
    withoutCost: [true, "true", "1", "yes"].includes(filters?.withoutCost),
    negativeCurrentMargin: [true, "true", "1", "yes"].includes(filters?.negativeCurrentMargin),
    requiresPromotionRemoval: [true, "true", "1", "yes"].includes(filters?.requiresPromotionRemoval),
    targetMarginRate: requestedMarginRate >= 0 && requestedMarginRate < 1 ? requestedMarginRate : null,
    health: ["healthy", "missing_cost", "alert", "campaign", "no_campaign"].includes(String(filters?.health || ""))
      ? String(filters.health)
      : "",
    minPriceCents: filters?.minPrice == null || filters?.minPrice === "" ? null : Math.round(Number(filters.minPrice) * 100),
    maxPriceCents: filters?.maxPrice == null || filters?.maxPrice === "" ? null : Math.round(Number(filters.maxPrice) * 100),
  };
}

function parseSalePriceCents(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
  }
  const raw = String(value || "").trim().replace(/^R\$\s*/i, "");
  if (!raw) return null;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function normalizeSelection(selection = {}) {
  const source = selection && typeof selection === "object" ? selection : {};
  if (source.mode === "all") {
    return {
      mode: "all",
      excludedKeys: Array.from(new Set(
        (Array.isArray(source.excludedKeys) ? source.excludedKeys : [])
          .map(String)
          .filter(Boolean),
      )).sort(),
      filters: normalizeFilters(source.filters || {}),
      catalogRevision: Number.isInteger(Number(source.catalogRevision))
        ? Math.max(0, Number(source.catalogRevision))
        : 0,
    };
  }
  return {
    mode: "keys",
    keys: Array.from(new Set(
      (Array.isArray(source.keys) ? source.keys : [])
        .map(String)
        .filter(Boolean),
    )).sort(),
  };
}

function buildPreviewRequestKey({ selection, filters, catalogSnapshotId = null }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      selection: normalizeSelection(selection),
      filters: normalizeFilters(filters),
      catalogSnapshotId: catalogSnapshotId ? String(catalogSnapshotId) : null,
    }))
    .digest("hex");
}

function mapReusablePreview(snapshot) {
  const result = parseJson(snapshot?.result, {});
  return {
    snapshotId: snapshot.id,
    createdAt: snapshot.created_at || snapshot.createdAt || null,
    reused: true,
    ...result,
  };
}

async function reuseOrCreatePreview({
  repository: snapshotRepository = repository,
  shopId,
  settingsVersion,
  selection,
  filters,
  forceRefresh = false,
  catalogSnapshotId = null,
  userId,
  buildResult,
  createId = () => crypto.randomUUID(),
}) {
  const normalizedSelection = normalizeSelection(selection);
  const normalizedFilters = normalizeFilters(filters);
  const requestKey = buildPreviewRequestKey({
    selection: normalizedSelection,
    filters: normalizedFilters,
    catalogSnapshotId,
  });

  if (forceRefresh) {
    await snapshotRepository.invalidateReusableSnapshots({ shopId, requestKey });
  } else {
    const snapshot = await snapshotRepository.findReusableSnapshot({
      shopId,
      settingsVersion,
      requestKey,
    });
    if (snapshot) return mapReusablePreview(snapshot);
  }

  const id = createId();
  const result = await buildResult({
    selection: normalizedSelection,
    filters: normalizedFilters,
  });
  await snapshotRepository.createSnapshot({
    id,
    shopId,
    settingsVersion,
    selection: normalizedSelection,
    result,
    userId,
    expiresAt: null,
    requestKey,
  });
  return {
    snapshotId: id,
    createdAt: new Date().toISOString(),
    reused: false,
    ...result,
  };
}

function filterCalculatedRows(rows, filters) {
  return rows.filter((row) => {
    if (filters.health === "healthy" && row.health !== "healthy") return false;
    if (filters.health === "missing_cost" && row.health !== "missing_cost") return false;
    if (filters.health === "alert" && !row.hasMarginAlert) return false;
    if (filters.health === "campaign" && !row.hasActiveCampaign) return false;
    if (filters.health === "no_campaign" && row.hasActiveCampaign) return false;
    return true;
  });
}

function buildCatalogSummary(items) {
  return items.reduce((acc, item) => {
    acc.total += 1;
    if (item.health === "healthy") acc.healthy += 1;
    if (item.health === "missing_cost") acc.missingCost += 1;
    if (item.hasMarginAlert) acc.alerts += 1;
    if (item.hasActiveCampaign) acc.activeCampaigns += 1;
    return acc;
  }, { total: 0, healthy: 0, missingCost: 0, alerts: 0, activeCampaigns: 0 });
}

function buildCatalogResult(rows, settings, calibration) {
  const items = rows.map((row) => toSnapshotItem(calculateProduct(row, settings, calibration)));
  return {
    catalog: true,
    engineVersion: "V7",
    settings: publicSettings(settings),
    summary: buildCatalogSummary(items),
    items,
  };
}

function isCatalogResult(snapshot) {
  return snapshot?.engineVersion === "V7" && Boolean(snapshot?.catalog) && Array.isArray(snapshot?.items) && snapshot?.summary && typeof snapshot.summary === "object";
}

async function getCatalogSnapshotWithRepository({
  repository: snapshotRepository = repository,
  shopId,
  settings,
  forceRefresh = false,
  userId,
  loadRows,
  createId,
  calibration,
}) {
  const resolve = (refresh) => reuseOrCreatePreview({
    repository: snapshotRepository,
    shopId,
    settingsVersion: settings.version,
    selection: FULL_CATALOG_SELECTION,
    filters: {},
    forceRefresh: refresh,
    userId,
    createId,
    buildResult: async () => buildCatalogResult(await loadRows(), settings, calibration),
  });
  const snapshot = await resolve(forceRefresh);
  return !forceRefresh && snapshot.reused && !isCatalogResult(snapshot)
    ? resolve(true)
    : snapshot;
}

async function getCatalogSnapshot({ shopId, forceRefresh = false, userId } = {}) {
  const [settings, calibration] = await Promise.all([getSettings(shopId), calibrationRepository.findBestCohort({ shopId })]);
  return getCatalogSnapshotWithRepository({
    shopId,
    settings,
    forceRefresh,
    userId,
    loadRows: () => repository.listPricingProducts({ shopId }),
    calibration,
  });
}

function filterCatalogRows(rows, filters) {
  const search = String(filters.q || "").toLocaleLowerCase("pt-BR");
  return filterCalculatedRows(rows, filters).filter((row) => {
    if (filters.withoutCost && asCents(row.costCents) > 0) return false;
    if (filters.requiresPromotionRemoval && !row.requiresPromotionRemoval) return false;
    if (filters.negativeCurrentMargin) {
      const currentMarginRate = Number(row.currentMarginRate);
      if (!Number.isFinite(currentMarginRate) || currentMarginRate >= 0) return false;
    }
    const effectivePriceCents = asCents(row.currentEffectivePriceCents || row.currentPriceCents);
    if (filters.minPriceCents != null && effectivePriceCents < filters.minPriceCents) return false;
    if (filters.maxPriceCents != null && effectivePriceCents > filters.maxPriceCents) return false;
    if (!search) return true;
    return [row.title, row.itemId, row.modelId, row.sku]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
  });
}

async function listProducts({ shopId, filters, page, pageSize, forceRefresh = false }) {
  const normalizedFilters = normalizeFilters(filters);
  const catalog = await getCatalogSnapshot({ shopId, forceRefresh });
  const rows = filterCatalogRows(catalog.items, normalizedFilters);
  const normalizedPage = normalizePage(page);
  const normalizedPageSize = normalizePageSize(pageSize);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  return {
    settings: catalog.settings,
    snapshotId: catalog.snapshotId,
    reused: catalog.reused,
    filters: normalizedFilters,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    total: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / normalizedPageSize)),
    items: rows.slice(offset, offset + normalizedPageSize),
  };
}

async function buildSelectedRows({ shopId, selection, filters = {}, forceRefresh = false, catalog = null }) {
  const normalized = selection && typeof selection === "object" ? selection : {};
  const sourceCatalog = catalog || await getCatalogSnapshot({ shopId, forceRefresh });
  if (normalized.mode === "all") {
    const normalizedFilters = normalizeFilters({ ...filters, ...(normalized.filters || {}) });
    const excluded = new Set((Array.isArray(normalized.excludedKeys) ? normalized.excludedKeys : []).map(String));
    return filterCatalogRows(sourceCatalog.items, normalizedFilters)
      .filter((row) => !excluded.has(row.key));
  }

  const keys = Array.from(new Set((Array.isArray(normalized.keys) ? normalized.keys : []).map(String))).slice(0, 10000);
  const selected = new Set(keys);
  return sourceCatalog.items.filter((row) => selected.has(row.key));
}

function toSnapshotItem(row) {
  return {
    key: row.key,
    productId: row.productId,
    itemId: row.itemId,
    modelId: row.modelId,
    title: row.title,
    sku: row.sku,
    imageUrl: row.imageUrl,
    currentPriceCents: row.currentPriceCents,
    activePromotionPriceCents: row.activePromotionPriceCents,
    currentEffectivePriceCents: row.currentEffectivePriceCents,
    currentDiscountPercent: row.currentDiscountPercent,
    currentMarginRate: row.currentMarginRate,
    currentNetPayoutCents: row.currentNetPayoutCents,
    currentBreakdown: row.currentBreakdown,
    costCents: row.costCents,
    health: row.health,
    hasMarginAlert: row.hasMarginAlert,
    targetMarginRate: row.targetMarginRate,
    hasActiveCampaign: row.hasActiveCampaign,
    giftCampaign: row.giftCampaign || null,
    requiresPromotionRemoval: Boolean(row.requiresPromotionRemoval),
    recommendedPriceCents: row.recommendedPriceCents,
    secondBestPriceCents: row.secondBestPriceCents,
    fullPriceCents: row.fullPriceCents,
    pixPriceCents: row.pixPriceCents,
    promotionPercent: row.promotionPercent,
    marginRate: row.marginRate,
    breakdown: row.breakdown,
    engineVersion: row.engineVersion,
    selectedMode: row.selectedMode,
    safePriceCents: row.safePriceCents,
    calibratedPriceCents: row.calibratedPriceCents,
    hybridPriceCents: row.hybridPriceCents,
    calibration: row.calibration,
    pricingWarnings: row.pricingWarnings,
  };
}

async function invalidateCatalogForGiftCampaignState({ shopId, status, repository: snapshotRepository = repository } = {}) {
  if (!GIFT_CAMPAIGN_CATALOG_INVALIDATION_STATES.has(String(status || "").trim().toLowerCase())) return false;
  await snapshotRepository.invalidateAllReusableSnapshots({ shopId: Number(shopId) });
  return true;
}

async function simulate({ shopId, userId, selection, filters, forceRefresh = false }) {
  const catalog = await getCatalogSnapshot({ shopId, forceRefresh, userId });
  return reuseOrCreatePreview({
    shopId,
    settingsVersion: catalog.settings.version,
    selection,
    filters,
    userId,
    forceRefresh,
    catalogSnapshotId: catalog.snapshotId,
    buildResult: async ({ selection: normalizedSelection, filters: normalizedFilters }) => {
      const selectedRows = await buildSelectedRows({
        shopId,
        selection: normalizedSelection,
        filters: normalizedFilters,
        catalog,
      });
      const effectiveSettings = normalizedFilters.targetMarginRate == null
        ? catalog.settings
        : { ...catalog.settings, targetMarginRate: normalizedFilters.targetMarginRate };
      const items = selectedRows.map((row) => toSnapshotItem(
        normalizedFilters.targetMarginRate == null
          ? row
          : calculateProduct(row, effectiveSettings, row.calibration),
      ));
      const summary = buildCatalogSummary(items);
      return {
        settings: publicSettings(effectiveSettings),
        summary,
        items,
        targetMarginRateOverride: normalizedFilters.targetMarginRate,
      };
    },
  });
}

function toSimulatorProduct(row) {
  return {
    key: row.key,
    productId: row.productId,
    itemId: row.itemId,
    modelId: row.modelId,
    title: row.title,
    sku: row.sku,
    costCents: row.costCents,
  };
}

async function simulateSalePriceWithRepository({
  repository: pricingRepository = repository,
  shopId,
  key,
  salePrice,
  settings,
  targetMarginRate,
}) {
  const salePriceCents = parseSalePriceCents(salePrice);
  if (!salePriceCents) {
    const error = new Error("Informe um preco de venda maior que zero.");
    error.statusCode = 422;
    throw error;
  }
  const row = await pricingRepository.getPricingRowByKey({ shopId, key });
  if (!row) {
    const error = new Error("Produto ativo nao encontrado para simulacao.");
    error.statusCode = 404;
    throw error;
  }
  const normalizedSettings = normalizeSettings(settings);
  const normalizedTargetMarginRate = asRate(
    targetMarginRate,
    normalizedSettings.targetMarginRate,
  );
  const breakdown = buildBreakdown({
    priceCents: salePriceCents,
    costCents: row.costCents,
    logisticsCostCents: 0,
    otherFixedCostCents: 0,
    settings: normalizedSettings,
  });
  return {
    product: toSimulatorProduct(row),
    salePriceCents,
    breakdown,
    netPayoutCents: breakdown.revenueAfterCouponCents - breakdown.totalFeesCents,
    marginRate: breakdown.marginRate,
    targetMarginRate: normalizedTargetMarginRate,
  };
}

async function simulateSalePrice({ shopId, key, salePrice }) {
  const settings = await getSettings(shopId);
  const catalog = await getCatalogSnapshot({ shopId });
  const row = catalog.items.find((item) => item.key === String(key));
  if (!row) {
    const error = new Error("Produto ativo nao encontrado para simulacao.");
    error.statusCode = 404;
    throw error;
  }
  const salePriceCents = parseSalePriceCents(salePrice);
  if (!salePriceCents) {
    const error = new Error("Informe um preco de venda maior que zero.");
    error.statusCode = 422;
    throw error;
  }
  const simulation = simulateV7SalePrice({
    priceCents: salePriceCents,
    costCents: row.costCents,
    logisticsCostCents: 0,
    otherFixedCostCents: 0,
    settings,
    calibration: row.calibration,
  });
  return {
    product: toSimulatorProduct(row),
    salePriceCents,
    mode: simulation.mode,
    breakdown: simulation.breakdown,
    netPayoutCents: simulation.netPayoutCents,
    marginRate: simulation.marginRate,
    warnings: simulation.warnings,
    targetMarginRate: settings.targetMarginRate,
  };
}

function formatSaoPauloDate(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function getAccountTacos({ shop, now = new Date() }) {
  const dateTo = formatSaoPauloDate(now);
  const dateFrom = `${dateTo.slice(0, 8)}01`;
  const start = new Date(`${dateFrom}T00:00:00.000-03:00`);
  const end = new Date(`${dateTo}T23:59:59.999-03:00`);
  const report = await collectRoasMetricsForRange({
    shop,
    shopDbId: shop.id,
    start,
    end,
    dateFrom,
    dateTo,
  });
  return {
    periodStart: dateFrom,
    periodEnd: dateTo,
    spend: report.metrics.spendCents / 100,
    gmv: report.metrics.storeGmvCents / 100,
    percent: report.metrics.tacosPct,
    source: report.sourceAdsTotals,
  };
}
async function getOverview({ shopId, forceRefresh = false }) {
  const [catalog, jobs] = await Promise.all([
    getCatalogSnapshot({ shopId, forceRefresh }),
    repository.listPricingJobs({ shopId, limit: 8 }),
  ]);
  return {
    settings: catalog.settings,
    snapshotId: catalog.snapshotId,
    reused: catalog.reused,
    totals: { ...catalog.summary, catalogueTotal: catalog.summary.total },
    latestJobs: jobs,
  };
}

function normalizeConflictPolicy(value) {
  const policy = String(value || "skip").trim().toLowerCase();
  return CONFLICT_POLICIES.has(policy) ? policy : "skip";
}

function itemConflictsWithTarget(conflict, item) {
  if (String(conflict.itemId) !== String(item.itemId)) return false;
  return conflict.modelId == null || String(conflict.modelId) === String(item.modelId || "");
}

async function fetchRemoteConflicts(shop, selectedItems) {
  const discounts = [];
  for (const status of ["upcoming", "ongoing"]) {
    let pageNo = 1;
    let more = true;
    while (more && pageNo <= 20) {
      const payload = await requestShopeeAuthed({ method: "GET", path: "/api/v2/discount/get_discount_list", query: { discount_status: status, page_no: pageNo, page_size: 100 }, shopId: String(shop.shopId) });
      const response = payload?.response || {};
      (Array.isArray(response.discount_list) ? response.discount_list : []).forEach((discount) => discounts.push({ ...discount, status: String(discount?.status || status).toLowerCase() }));
      more = Boolean(response.more);
      pageNo += 1;
    }
  }
  const selectedItemIds = new Set(selectedItems.map((item) => String(item.itemId)));
  const conflicts = [];
  for (const discount of discounts) {
    const discountId = discount?.discount_id;
    if (!discountId) continue;
    let pageNo = 1;
    let more = true;
    while (more && pageNo <= 20) {
      const payload = await requestShopeeAuthed({ method: "GET", path: "/api/v2/discount/get_discount", query: { discount_id: Number(discountId), page_no: pageNo, page_size: 100 }, shopId: String(shop.shopId) });
      const response = payload?.response || {};
      for (const item of Array.isArray(response.item_list) ? response.item_list : []) {
        if (!selectedItemIds.has(String(item?.item_id || ""))) continue;
        const models = Array.isArray(item?.model_list) && item.model_list.length ? item.model_list : [null];
        models.forEach((model) => conflicts.push({
          itemId: String(item.item_id), modelId: model?.model_id == null ? null : String(model.model_id),
          name: String(discount.discount_name || `Promocao ${discountId}`), status: discount.status,
          startTime: discount.start_time ? new Date(Number(discount.start_time) * 1000).toISOString() : null,
          endTime: discount.end_time ? new Date(Number(discount.end_time) * 1000).toISOString() : null,
          shopeeDiscountId: String(discountId), source: "shopee",
        }));
      }
      more = Boolean(response.more);
      pageNo += 1;
    }
  }
  return conflicts;
}

async function getConflicts({ shop, selection, filters, syncRemote = false }) {
  const selected = await buildSelectedRows({ shopId: shop.id, selection, filters });
  const healthy = selected.filter((item) => item.health === "healthy");
  const local = await repository.getLocalPromotionConflicts({ shopId: shop.id, rows: healthy });
  let remote = [];
  if (syncRemote && healthy.length) remote = await fetchRemoteConflicts(shop, healthy);
  const all = [...local, ...remote];
  const matched = healthy.flatMap((item) => all.filter((conflict) => itemConflictsWithTarget(conflict, item)).map((conflict) => ({ ...conflict, key: item.key, title: item.title })));
  return { selected: selected.length, eligible: healthy.length, conflicts: matched, source: syncRemote ? "local_and_shopee" : "local" };
}

async function createJob({ shop, userId, snapshotId, conflictPolicy }) {
  const snapshot = await repository.getSnapshot({ id: snapshotId, shopId: shop.id });
  if (!snapshot) {
    const error = new Error("Prévia não encontrada para esta loja.");
    error.statusCode = 404;
    throw error;
  }
  if (snapshot.expires_at && new Date(snapshot.expires_at).getTime() < Date.now()) {
    const error = new Error("A prévia expirou. Simule novamente antes de aplicar.");
    error.statusCode = 409;
    throw error;
  }
  const payload = parseJson(snapshot.result, {});
  const policy = normalizeConflictPolicy(conflictPolicy);
  const healthyItems = (Array.isArray(payload.items) ? payload.items : []).filter(
    (item) => item.health === "healthy" && asCents(item.recommendedPriceCents) > 0,
  );
  const items = policy === "raise_base_remove_promotions"
    ? healthyItems.filter((item) => Boolean(item.requiresPromotionRemoval))
    : healthyItems;
  if (!items.length) {
    const error = new Error("Nenhum produto saudável com preço sugerido válido foi selecionado para aplicar.");
    error.statusCode = 422;
    throw error;
  }
  const id = crypto.randomUUID();
  const createdJob = await repository.createPricingJob({
    id, shopId: shop.id, snapshotId, conflictPolicy: policy,
    idempotencyKey: `pricing-v6:${shop.id}:${snapshotId}:${policy}`,
    userId,
    summary: { total: items.length, eligible: items.length, skipped: 0, applied: 0, failed: 0 },
    items: items.map((item) => ({ ...item, state: "pending" })),
  });
  return repository.getPricingJob({
    id: createdJob?.id || id,
    shopId: shop.id,
    includeItems: true,
  });
}

async function confirmJob({ shop, jobId, enqueue }) {
  const settings = await getSettings(shop.id);
  if (!settings.applicationEnabled) {
    const error = new Error("A aplicação na Shopee está desativada nas configurações deste motor.");
    error.statusCode = 409;
    error.code = "pricing_application_disabled";
    throw error;
  }
  const job = await repository.getPricingJob({ id: jobId, shopId: shop.id, includeItems: false });
  if (!job) {
    const error = new Error("Job de precificação não encontrado.");
    error.statusCode = 404;
    throw error;
  }
  if (job.state !== "awaiting_confirmation") {
    const error = new Error("Este job já foi confirmado, processado ou cancelado.");
    error.statusCode = 409;
    throw error;
  }
  await repository.updatePricingJob({ id: job.id, shopId: shop.id, state: "queued", queuedAt: new Date(), progress: { phase: "queued", processed: 0, total: Number(job.summary?.total || 0) } });
  await enqueue(job.id);
  return repository.getPricingJob({ id: job.id, shopId: shop.id, includeItems: false });
}

function getResponseError(payload) {
  const responseError = payload?.error || payload?.message || payload?.response?.error;
  return responseError ? String(responseError) : null;
}

async function shopeeCall(shop, path, body) {
  const payload = await requestShopeeAuthed({ method: "POST", path, body, shopId: String(shop.shopId) });
  const error = getResponseError(payload);
  if (error) {
    const exception = new Error(error);
    exception.shopee = payload;
    throw exception;
  }
  return payload;
}

function chunks(rows, size) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}


function hasModelId(item) {
  return item?.modelId != null && String(item.modelId).trim() !== "" && Number(item.modelId) !== 0;
}

function buildDiscountItemPayload(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    const item = entry?.item || entry;
    const itemId = Number(item?.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new Error("Invalid Shopee item for campaign.");
    let group = groups.get(itemId);
    if (!group) {
      group = { item_id: itemId, entries: [], model_list: [] };
      groups.set(itemId, group);
    }
    group.entries.push(entry);
    if (hasModelId(item)) {
      group.model_list.push({ model_id: Number(item.modelId), model_promotion_price: toShopeePrice(item.recommendedPriceCents) });
    } else {
      group.item_promotion_price = toShopeePrice(item.recommendedPriceCents);
    }
  }
  return [...groups.values()].map(({ entries: groupedEntries, model_list, ...payload }) => ({
    entries: groupedEntries,
    payload: model_list.length ? { ...payload, model_list } : payload,
  }));
}

function getDiscountItemFailure(payload, item) {
  const errors = Array.isArray(payload?.response?.error_list) ? payload.response.error_list : [];
  const itemId = String(item?.itemId || "");
  const modelId = String(item?.modelId || 0);
  const failure = errors.find((entry) => {
    if (String(entry?.item_id || "") !== itemId) return false;
    const errorModelId = String(entry?.model_id || 0);
    return errorModelId === "0" || errorModelId === modelId;
  });
  if (!failure) return null;
  return [failure.fail_error, failure.fail_message].filter(Boolean).join(": ") || "Shopee rejected the campaign item.";
}
function splitJobItemsByActiveKeys(items, activeKeys) {
  const active = [];
  const inactive = [];
  const keys = activeKeys instanceof Set ? activeKeys : new Set(activeKeys || []);
  for (const item of items || []) {
    const target = item?.item || item;
    const key = `${target.productId}:${target.modelId == null || target.modelId === "" ? 0 : target.modelId}`;
    (keys.has(key) ? active : inactive).push(item);
  }
  return { active, inactive };
}

async function markItem({ shopId, jobId, item, state, discountId, payload, errorMessage, auditAction }) {
  await repository.updateJobItem({ id: item.id, state, shopeeDiscountId: discountId, responsePayload: payload, errorMessage });
  await repository.createAudit({
    shopId, jobId, item, action: auditAction || (state === "applied" ? "promotion_applied" : `promotion_${state}`),
    payload: payload || { errorMessage: errorMessage || null },
  });
}

async function runApplyJob({ jobId, progress }) {
  const initialJob = await repository.getPricingJob({ id: jobId, shopId: undefined, includeItems: true });
  if (!initialJob) throw new Error("Job de precificação não encontrado.");
  if (initialJob.state !== "queued") return { ok: true, ignored: true, reason: `job_state_${initialJob.state}` };

  const shop = { id: initialJob.shopId };
  const shopRow = await queryShopIdentity(initialJob.shopId);
  if (!shopRow) throw new Error("Loja do job não encontrada.");
  shop.shopId = shopRow.shopId;
  await repository.updatePricingJob({ id: jobId, shopId: shop.id, state: "running", startedAt: new Date(), progress: { phase: "validating", processed: 0, total: initialJob.items.length } });

  const settings = await getSettings(shop.id);
  if (!settings.applicationEnabled) throw new Error("Aplicação desativada antes do processamento.");
  const pendingItems = initialJob.items.filter((item) => item.state === "pending" && Number(item.recommendedPriceCents) > 0);
  const activeKeys = await repository.getActivePricingKeys({
    shopId: shop.id,
    keys: pendingItems.map((item) => `${item.productId}:${item.modelId == null || item.modelId === "" ? 0 : item.modelId}`),
  });
  const { active: activeItems, inactive: inactiveItems } = splitJobItemsByActiveKeys(pendingItems, activeKeys);
  const livePrices = await fetchLivePriceValidation(shop, activeItems);
  const isBaseRaiseOnlyJob = initialJob.conflictPolicy === "raise_base_remove_promotions";
  const plannedItems = activeItems.map((item) => {
    const key = `${item.itemId}:${item.modelId == null || item.modelId === "" ? 0 : item.modelId}`;
    const live = livePrices.get(key) || null;
    if (!live?.basePriceCents) return { item, plan: { kind: "unverified", basePriceCents: 0 }, live };
    if (isBaseRaiseOnlyJob) {
      const targetBasePriceCents = asCents(item.recommendedPriceCents);
      return targetBasePriceCents > asCents(live.basePriceCents)
        ? { item, plan: { kind: "raise_base_after_promotion_removal", basePriceCents: targetBasePriceCents }, live }
        : { item, plan: { kind: "invalid", basePriceCents: targetBasePriceCents }, live };
    }
    return { item, plan: planPromotionApplication({ ...item, previousPriceCents: live.basePriceCents }), live };
  });
  const invalidItems = plannedItems.filter(({ plan }) => plan.kind === "invalid" || plan.kind === "unverified");
  const activeCandidates = plannedItems.filter(({ plan }) => plan.kind !== "invalid" && plan.kind !== "unverified");
  let skipped = 0;
  for (const { item, plan } of invalidItems) {
    const errorMessage = plan.kind === "unverified"
      ? "Preço base não confirmado ao vivo na Shopee; item não aplicado por segurança."
      : isBaseRaiseOnlyJob
        ? "O preço sugerido não está acima do preço-base confirmado; nenhuma elevação foi enviada."
        : "O preço cheio calculado não é maior que o preço sugerido; nenhuma promoção inválida foi criada.";
    await markItem({ shopId: shop.id, jobId, item, state: "skipped", errorMessage });
    skipped += 1;
  }
  for (const item of inactiveItems) {
    await markItem({ shopId: shop.id, jobId, item, state: "skipped", errorMessage: "Anúncio não está ativo na Shopee." });
    skipped += 1;
  }

  const remoteConflicts = activeCandidates.length ? await fetchRemoteConflicts(shop, activeCandidates.map(({ item }) => item)) : [];
  const localConflicts = activeCandidates.length ? await repository.getLocalPromotionConflicts({ shopId: shop.id, rows: activeCandidates.map(({ item }) => item) }) : [];
  const conflicts = [...remoteConflicts, ...localConflicts];
  const toApply = [];
  for (const entry of activeCandidates) {
    const matches = conflicts.filter((conflict) => itemConflictsWithTarget(conflict, entry.item));
    const productReportsPromotion = Number(entry.live?.promotionPriceCents || 0) > 0;
    if (isBaseRaiseOnlyJob) {
      const remoteMatches = matches.filter((match) => match.source === "shopee" && match.shopeeDiscountId);
      if (productReportsPromotion && !remoteMatches.length) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: "O produto informa promoção, mas ela não foi identificada para remoção; o preço-base foi preservado por segurança." });
        skipped += 1;
        continue;
      }
      try {
        const removed = new Set();
        for (const match of remoteMatches) {
          const key = `${match.shopeeDiscountId}:${entry.item.itemId}:${entry.item.modelId || 0}`;
          if (removed.has(key)) continue;
          removed.add(key);
          await shopeeCall(shop, "/api/v2/discount/delete_discount_item", { discount_id: Number(match.shopeeDiscountId), item_id: Number(entry.item.itemId), model_id: Number(entry.item.modelId || 0) });
        }
        toApply.push({ ...entry, removedPromotions: remoteMatches.map((match) => match.shopeeDiscountId) });
      } catch (error) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: `Promoção não removida; preço-base preservado: ${error.message}` });
        skipped += 1;
      }
      continue;
    }
    if (!matches.length) {
      if (productReportsPromotion) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: "O produto informa preço promocional na Shopee, mas a campanha não foi identificada para remoção; nenhuma nova promoção foi criada." });
        skipped += 1;
        continue;
      }
      toApply.push({ ...entry, promotionDetected: false });
      continue;
    }
    if (initialJob.conflictPolicy === "replace_existing") {
      const remoteMatches = matches.filter((match) => match.source === "shopee" && match.shopeeDiscountId);
      if (!remoteMatches.length) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: "A promoção atual não pôde ser confirmada na Shopee; nenhuma nova promoção foi criada." });
        skipped += 1;
        continue;
      }
      try {
        const removed = new Set();
        for (const match of remoteMatches) {
          const key = `${match.shopeeDiscountId}:${entry.item.itemId}:${entry.item.modelId || 0}`;
          if (removed.has(key)) continue;
          removed.add(key);
          await shopeeCall(shop, "/api/v2/discount/delete_discount_item", { discount_id: Number(match.shopeeDiscountId), item_id: Number(entry.item.itemId), model_id: Number(entry.item.modelId || 0) });
        }
        toApply.push(entry);
        continue;
      } catch (error) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: `Promoção atual não removida: ${error.message}` });
        skipped += 1;
        continue;
      }
    }
    if (initialJob.conflictPolicy === "replace_upcoming") {
      const upcomingMatch = matches.find((match) => match.source === "shopee" && match.status === "upcoming" && match.shopeeDiscountId);
      if (upcomingMatch) {
        try {
          await shopeeCall(shop, "/api/v2/discount/delete_discount_item", { discount_id: Number(upcomingMatch.shopeeDiscountId), item_id: Number(entry.item.itemId), model_id: Number(entry.item.modelId || 0) });
          toApply.push(entry);
          continue;
        } catch (error) {
          await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: `Conflito não removido: ${error.message}` });
          skipped += 1;
          continue;
        }
      }
    }
    await markItem({ shopId: shop.id, jobId, item: entry.item, state: "skipped", errorMessage: matches.some((match) => match.status === "ongoing") ? "Promoção em andamento preservada." : "Conflito de promoção preservado." });
    skipped += 1;
  }

  let applied = 0;
  let failed = 0;
  const readyToApply = [];
  const baseRaiseUpdates = new Map();
  const basePriceUpdates = new Map();
  for (const entry of toApply) {
    if (entry.plan.kind === "raise_base_after_promotion_removal") {
      const group = baseRaiseUpdates.get(String(entry.item.itemId)) || [];
      group.push(entry);
      baseRaiseUpdates.set(String(entry.item.itemId), group);
      continue;
    }
    if (entry.plan.kind !== "base_price_then_promotion") { readyToApply.push(entry); continue; }
    const group = basePriceUpdates.get(String(entry.item.itemId)) || [];
    group.push(entry);
    basePriceUpdates.set(String(entry.item.itemId), group);
  }
  for (const [itemId, entries] of baseRaiseUpdates) {
    try {
      const payload = await ShopeeProductWriteService.updatePrice({
        shopId: String(shop.shopId),
        body: { item_id: Number(itemId), price_list: entries.map(({ item, plan }) => ({ model_id: Number(item.modelId || 0), original_price: toShopeePrice(plan.basePriceCents) })) },
      });
      for (const entry of entries) {
        await markItem({
          shopId: shop.id,
          jobId,
          item: entry.item,
          state: "applied",
          payload: { basePrice: payload, removedPromotions: entry.removedPromotions || [], validation: { previousBasePriceCents: entry.live?.basePriceCents || 0, targetBasePriceCents: entry.plan.basePriceCents } },
          auditAction: "base_price_raised_after_promotion_removal",
        });
        applied += 1;
      }
    } catch (error) {
      for (const { item } of entries) {
        await markItem({ shopId: shop.id, jobId, item, state: "failed", payload: error.shopee || null, errorMessage: `Preço-base não atualizado: ${error.message}`, auditAction: "base_price_raise_failed" });
        failed += 1;
      }
    }
  }

  for (const [itemId, entries] of basePriceUpdates) {
    try {
      const payload = await ShopeeProductWriteService.updatePrice({
        shopId: String(shop.shopId),
        body: { item_id: Number(itemId), price_list: entries.map(({ item, plan }) => ({ model_id: Number(item.modelId || 0), original_price: toShopeePrice(plan.basePriceCents) })) },
      });
      entries.forEach((entry) => readyToApply.push({ ...entry, basePricePayload: payload }));
    } catch (error) {
      for (const { item } of entries) {
        await markItem({ shopId: shop.id, jobId, item, state: "failed", payload: error.shopee || null, errorMessage: `Preço base não atualizado: ${error.message}` });
        failed += 1;
      }
    }
  }

  const startTime = new Date(Date.now() + APPLY_START_DELAY_MS);
  const endTime = new Date(startTime.getTime() + APPLY_DURATION_MS);
  for (const [chunkIndex, chunk] of chunks(readyToApply, JOB_CHUNK_SIZE).entries()) {
    const latest = await repository.getPricingJob({ id: jobId, shopId: shop.id, includeItems: false });
    if (latest?.cancelRequestedAt) break;
    let discountId = null;
    try {
      const campaignPayload = await shopeeCall(shop, "/api/v2/discount/add_discount", { discount_name: `Davantti Precificação ${new Date().toLocaleDateString("pt-BR")} ${chunkIndex + 1}`, start_time: Math.floor(startTime.getTime() / 1000), end_time: Math.floor(endTime.getTime() / 1000) });
      discountId = campaignPayload?.response?.discount_id || campaignPayload?.discount_id || null;
      if (!discountId) throw new Error("Shopee não retornou o identificador da promoção.");
      let campaignApplied = 0;
      const discountItems = buildDiscountItemPayload(chunk);
      for (const batch of chunks(discountItems, API_BATCH_SIZE)) {
        try {
          const payload = await shopeeCall(shop, "/api/v2/discount/add_discount_item", { discount_id: Number(discountId), item_list: batch.map(({ payload: itemPayload }) => itemPayload) });
          for (const group of batch) {
            for (const entry of group.entries) {
              const errorMessage = getDiscountItemFailure(payload, entry.item);
              if (errorMessage) {
                await markItem({ shopId: shop.id, jobId, item: entry.item, state: "failed", discountId, payload, errorMessage });
                failed += 1;
                continue;
              }
              await markItem({ shopId: shop.id, jobId, item: entry.item, state: "applied", discountId, payload: { promotion: payload, basePrice: entry.basePricePayload || null, validation: { basePriceCents: entry.plan.basePriceCents, promotionPriceCents: entry.live?.promotionPriceCents || 0, source: entry.live?.source || null, promotionDetected: Boolean(entry.promotionDetected) } } });
              applied += 1;
              campaignApplied += 1;
            }
          }
        } catch (error) {
          for (const group of batch) {
            for (const entry of group.entries) {
              await markItem({ shopId: shop.id, jobId, item: entry.item, state: "failed", discountId, payload: error.shopee || null, errorMessage: error.message });
              failed += 1;
            }
          }
        }
        const processed = applied + failed + skipped;
        const currentProgress = { phase: "applying", processed, total: pendingItems.length, applied, failed, skipped };
        await repository.updatePricingJob({ id: jobId, shopId: shop.id, progress: currentProgress, summary: { total: pendingItems.length, applied, failed, skipped } });
        if (typeof progress === "function") await progress(currentProgress);
      }
      if (campaignApplied === 0) {
        try {
          await shopeeCall(shop, "/api/v2/discount/delete_discount", { discount_id: Number(discountId) });
        } catch (_error) {
          // Job details retain failed items even if the empty campaign cannot be removed.
        }
      }
    } catch (error) {
      for (const entry of chunk) {
        await markItem({ shopId: shop.id, jobId, item: entry.item, state: "failed", discountId, payload: error.shopee || null, errorMessage: error.message });
        failed += 1;
      }
    }
  }

  const latestJob = await repository.getPricingJob({ id: jobId, shopId: shop.id, includeItems: false });
  const finalState = latestJob?.cancelRequestedAt || latestJob?.state === "cancelled" ? "cancelled" : failed > 0 ? (applied > 0 ? "partial_failed" : "failed") : "completed";
  const summary = { total: pendingItems.length, applied, failed, skipped };
  await repository.updatePricingJob({ id: jobId, shopId: shop.id, state: finalState, summary, progress: { phase: finalState, ...summary }, finishedAt: new Date(), errorMessage: failed ? "Alguns itens não foram aplicados; consulte o detalhe do job." : null });
  return { ok: finalState === "completed", jobId, state: finalState, summary };
}
async function validateGiftCampaignBasePrices({ shop, items, conflictPolicy = "skip" } = {}) {
  const policy = normalizeConflictPolicy(conflictPolicy);
  const selected = Array.isArray(items) ? items : [];
  const livePrices = await fetchLivePriceValidation(shop || {}, selected);
  const eligibleItems = [];
  const skippedItems = [];
  for (const item of selected) {
    const modelId = item?.modelId == null || String(item.modelId) === "" ? 0 : item.modelId;
    const live = livePrices.get(`${item?.itemId}:${modelId}`);
    if (!live?.basePriceCents) {
      skippedItems.push({ item, reason: "base_price_unverified" });
      continue;
    }
    if (policy === "skip" && Number(live.promotionPriceCents || 0) > 0) {
      skippedItems.push({ item, reason: "promotion_conflict" });
      continue;
    }
    eligibleItems.push(item);
  }
  return { items: eligibleItems, eligibleItems, skippedItems, policy };
}
async function queryShopIdentity(shopId) {
  const { queryOne } = require("../config/postgres");
  const row = await queryOne('SELECT id, "shopId" AS shop_id FROM "Shop" WHERE id = $1 LIMIT 1', [Number(shopId)]);
  return row ? { id: Number(row.id), shopId: String(row.shop_id) } : null;
}

async function cancelJob({ shopId, jobId }) {
  const job = await repository.getPricingJob({ id: jobId, shopId, includeItems: false });
  if (!job) {
    const error = new Error("Job de precificação não encontrado.");
    error.statusCode = 404;
    throw error;
  }
  if (["completed", "partial_failed", "failed"].includes(job.state)) return job;
  await repository.updatePricingJob({ id: jobId, shopId, state: "cancelled", cancelRequestedAt: new Date(), finishedAt: job.state === "awaiting_confirmation" ? new Date() : undefined });
  return repository.getPricingJob({ id: jobId, shopId, includeItems: false });
}

async function failApplyJob({ jobId, error }) {
  const job = await repository.getPricingJob({ id: jobId, shopId: undefined, includeItems: false });
  if (!job || ["completed", "partial_failed", "cancelled"].includes(job.state)) return;
  await repository.updatePricingJob({
    id: job.id,
    shopId: job.shopId,
    state: "failed",
    finishedAt: new Date(),
    errorMessage: String(error?.message || error || "Falha inesperada ao aplicar precos."),
    progress: { ...(job.progress || {}), phase: "failed" },
  });
}

async function retryJob({ shop, jobId, enqueue }) {
  const job = await repository.getPricingJob({ id: jobId, shopId: shop.id, includeItems: false });
  if (!job) {
    const error = new Error("Job de precificação não encontrado.");
    error.statusCode = 404;
    throw error;
  }
  if (!["failed", "partial_failed"].includes(job.state)) {
    const error = new Error("Somente jobs com falha podem ser reprocessados.");
    error.statusCode = 409;
    throw error;
  }
  const restored = await repository.resetFailedJobItems(job.id);
  if (!restored) {
    const error = new Error("Este job não possui itens com falha para reprocessar.");
    error.statusCode = 409;
    throw error;
  }
  const summary = { ...(job.summary || {}), failed: 0 };
  await repository.updatePricingJob({ id: job.id, shopId: shop.id, state: "queued", queuedAt: new Date(), finishedAt: null, errorMessage: null, summary, progress: { phase: "queued", retrying: restored, total: Number(summary.total || 0) } });
  await enqueue(job.id);
  return repository.getPricingJob({ id: job.id, shopId: shop.id, includeItems: false });
}

async function listAudit({ shopId, page, pageSize }) {
  return repository.listAudit({ shopId, page, pageSize });
}

module.exports = {
  getSettings,
  saveSettings,
  listProducts,
  simulate,
  simulateSalePrice,
  getOverview,
  getConflicts,
  createJob,
  confirmJob,
  runApplyJob,
  cancelJob,
  failApplyJob,
  retryJob,
  listAudit,
  publicSettings,
  getAccountTacos,
  refreshCatalogPrices,
  validateGiftCampaignBasePrices,
  invalidateCatalogForGiftCampaignState,
  _test: {
    splitJobItemsByActiveKeys,
    buildPreviewRequestKey,
    reuseOrCreatePreview,
    simulateSalePriceWithRepository,
    calculateProduct,
    getCatalogSnapshotWithRepository,
    mapSettings,
    mergeSettingsInput,
    normalizeOptionalTaxRate,
    isPromotionPriceEligible,
    planPromotionApplication,
    normalizeConflictPolicy,
    resolveShopeeBasePriceCents,
    resolveShopeePromotionPriceCents,
    normalizeFilters,
    filterCatalogRows,
    buildDiscountItemPayload,
    getDiscountItemFailure,
    invalidateCatalogForGiftCampaignState,
    GIFT_CAMPAIGN_CATALOG_INVALIDATION_STATES,
  },
};