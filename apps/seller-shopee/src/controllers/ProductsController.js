const {
  findShopByDbIdAndAccountId,
} = require("../repositories/operationsSqlRepository");
const {
  countProductsForManagement,
  findProductDetailByShopAndItemId,
  findProductIdByShopAndItemId,
  listGroupedProductSalesSince,
  listProductItemIdsByDbIds,
  listProductSalesSnapshotByRange,
  listProductsForManagementExport,
  listProductsForManagement,
  listProductsByShopAndIdentifiers,
  listProductsByShopAndItemIdsForManagement,
  mapSoldQuantityByItemIds,
  listVariationSalesByProductId,
  listProductsWithoutSalesSince,
  replaceProductImages,
  updateProductByShopAndItemId,
} = require("../repositories/productSqlRepository");
const {
  listAggregatedProductTrafficDailyByRange,
  listTrackedItemIdsForDate,
  upsertProductTrafficDailySnapshots,
} = require("../repositories/productTrafficSqlRepository");
const {
  listActivePriceLocksByItemIds,
} = require("../repositories/priceIncreaseSqlRepository");
const ShopeeProductWriteService = require("../services/ShopeeProductWriteService");
const ShopeeMediaService = require("../services/ShopeeMediaService");
const ShopeeAmsService = require("../services/ShopeeAmsService");
const ShopeeProductService = require("../services/ShopeeProductService");
const {
  analyzeLogistics,
  extractLogistics,
  analyzeSpxPhysicalEligibility,
} = require("../utils/productLogistics");
const { formatRemainingFromLock } = require("../services/priceIncreasePolicyService");
const SALES_CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SALES_CATEGORY_CACHE = new Map();
const SALES_CONTROL_ORGANIC_CACHE_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.SHOPEE_SALES_CONTROL_ORGANIC_CACHE_TTL_MS || 2 * 60 * 60 * 1000) || 2 * 60 * 60 * 1000,
);
const SALES_CONTROL_ORGANIC_FETCH_LIMIT = Math.max(
  20,
  Number(process.env.SHOPEE_SALES_CONTROL_ORGANIC_FETCH_LIMIT || 300) || 300,
);
const SALES_CONTROL_ORGANIC_CONCURRENCY = Math.max(
  1,
  Math.min(
    12,
    Number(process.env.SHOPEE_SALES_CONTROL_ORGANIC_CONCURRENCY || 6) || 6,
  ),
);
const SALES_CONTROL_ORGANIC_CACHE = new Map();
const PRODUCT_EXPORT_LIVE_ITEM_LIMIT = Math.max(
  0,
  Number(process.env.SHOPEE_PRODUCT_EXPORT_LIVE_ITEM_LIMIT || 0) || 0,
);
const PRODUCT_EXPORT_LIVE_MODEL_LIMIT = Math.max(
  0,
  Number(process.env.SHOPEE_PRODUCT_EXPORT_LIVE_MODEL_LIMIT || 0) || 0,
);
const PRODUCT_EXPORT_LIVE_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.SHOPEE_PRODUCT_EXPORT_LIVE_TIMEOUT_MS || 12000) || 12000,
);
const PRODUCT_EXPORT_LIVE_MAX_PRODUCTS = Math.max(
  0,
  Number(process.env.SHOPEE_PRODUCT_EXPORT_LIVE_MAX_PRODUCTS || 0) || 0,
);

function onlyDigits(v) {
  return /^\d+$/.test(String(v ?? "").trim());
}

function dedupPreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const value of arr) {
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function chunk(items = [], size = 50) {
  const source = Array.isArray(items) ? items : [];
  const safeSize = Math.max(1, Number(size) || 1);
  const result = [];
  for (let i = 0; i < source.length; i += safeSize) {
    result.push(source.slice(i, i + safeSize));
  }
  return result;
}

async function mapWithConcurrency(items = [], concurrency = 4, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(list.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) break;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, () => runWorker()),
  );
  return results;
}

function parseShopeeErrorMessage(error) {
  const shopeePayload = error?.shopee || null;
  if (shopeePayload) {
    const code = String(shopeePayload?.error || "").trim();
    const message = String(
      shopeePayload?.message ||
        shopeePayload?.warning ||
        shopeePayload?.error ||
        "",
    ).trim();
    if (message && code && code !== message) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  return String(error?.message || error || "Erro desconhecido");
}

function isMissingPriceUpdateTableError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const searchSpace = `${String(error?.message || "")} ${String(error?.detail || "")} ${String(error?.details || "")}`
    .toLowerCase();
  return code === "42P01" && searchSpace.includes("productpriceupdateevent");
}

async function listActivePriceLocksSafe(shopId, itemIds, at = new Date()) {
  try {
    return await listActivePriceLocksByItemIds(shopId, itemIds, at);
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      return new Map();
    }
    throw error;
  }
}

function normalizeProductStatus(status) {
  return String(status || "")
    .trim()
    .toUpperCase();
}

function isAlreadyUnlistedStatus(status) {
  const normalized = normalizeProductStatus(status);
  return normalized === "UNLIST" || normalized === "UNLISTED";
}

function isPausedProductStatus(status) {
  const normalized = normalizeProductStatus(status);
  return normalized === "UNLIST" || normalized === "UNLISTED";
}

function isActiveProductStatus(status) {
  const normalized = normalizeProductStatus(status);
  return normalized === "NORMAL" || normalized === "ACTIVE";
}

function resolveProductTotalStock(product) {
  if (!product || typeof product !== "object") return 0;
  const hasModel = Boolean(product.hasModel);
  if (hasModel) {
    return Math.max(0, toNumberOrZero(product.modelsStock));
  }
  return Math.max(0, toNumberOrZero(product.stock));
}

function getActiveShopDbId(req) {
  return req.auth?.activeShopId || null;
}

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const shopDbId = getActiveShopDbId(req);
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }

  const shop = await findShopByDbIdAndAccountId(shopDbId, req.auth.accountId);
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCommaSeparatedValues(rawValue) {
  const source = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue || "");
  return Array.from(
    new Set(
      source
        .split(",")
        .map((token) => String(token || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseProductStatusFilters(rawValue) {
  return parseCommaSeparatedValues(rawValue)
    .map((value) => value.toUpperCase())
    .filter((value) => value !== "ALL" && value !== "TODOS");
}

function parseSkuFilters(rawValue) {
  return parseCommaSeparatedValues(rawValue)
    .map((value) => value.toUpperCase())
    .filter(Boolean);
}

function parseListInput(rawValue) {
  const source = String(rawValue || "");
  return Array.from(
    new Set(
      source
        .split(/[\n,;]+/g)
        .map((token) => String(token || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseItemIdsInput(rawValue) {
  return parseListInput(rawValue).filter((value) => /^\d+$/.test(value));
}

function parseSkusInput(rawValue) {
  return parseListInput(rawValue)
    .map((value) => value.toUpperCase())
    .filter(Boolean);
}

function normalizeDeadlineShippingFilter(rawValue) {
  const value = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (["spx", "shopee_xpress", "shopee-xpress"].includes(value)) return "spx";
  if (["seller", "seller_logistics", "seller-logistics", "intelipost"].includes(value))
    return "seller";
  return "all";
}

function isPromotionLockError(error) {
  const code = String(error?.shopee?.error || "")
    .trim()
    .toLowerCase();
  const message = String(error?.shopee?.message || error?.message || "")
    .trim()
    .toLowerCase();
  return (
    code.includes("error_flash_sale_days_to_ship_lock") ||
    code.includes("error_cannt_edit_pre_order_in_promotion") ||
    message.includes("error_flash_sale_days_to_ship_lock") ||
    message.includes("error_cannt_edit_pre_order_in_promotion")
  );
}

function mapDeadlineErrorMessage(error) {
  const code = String(error?.shopee?.error || "")
    .trim()
    .toLowerCase();
  const message = String(error?.shopee?.message || error?.message || "").trim();
  if (code.includes("error_flash_sale_days_to_ship_lock")) {
    return "Produto com flash sale ativa/futura: não é possível alterar o prazo de envio.";
  }
  if (code.includes("error_cannt_edit_pre_order_in_promotion")) {
    return "Produto em promoção: não é permitido habilitar pré-venda. Apenas remover prazo sob encomenda.";
  }
  if (isPromotionLockError(error)) {
    return "Produto em promoção/flash sale bloqueando alteração de prazo.";
  }
  return message || "Falha ao atualizar prazo do produto.";
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveProductPriceForExport(product, model = null) {
  const modelPrice = model ? toFiniteNumberOrNull(model.price) : null;
  if (modelPrice != null) {
    return modelPrice;
  }

  const minPrice = toFiniteNumberOrNull(product?.priceMin);
  const maxPrice = toFiniteNumberOrNull(product?.priceMax);
  if (minPrice != null) return minPrice;
  if (maxPrice != null) return maxPrice;
  return null;
}

function resolvePromotionPriceForExport(product, model = null) {
  const modelPromotionPrice = model
    ? toFiniteNumberOrNull(
        model.activeModelPromotionPrice ?? model.modelPromotionPrice,
      )
    : null;
  if (modelPromotionPrice != null) {
    return modelPromotionPrice;
  }

  const productPromotionPrice = toFiniteNumberOrNull(
    product?.activePromotionPrice ?? product?.promotionPrice,
  );
  if (productPromotionPrice != null) {
    return productPromotionPrice;
  }

  return null;
}

function pickFirstFiniteFromKeys(source, keys = []) {
  const data = source && typeof source === "object" ? source : {};
  for (const key of keys) {
    const value = toFiniteNumberOrNull(data[key]);
    if (value != null) return value;
  }
  return null;
}

function normalizePriceInfo(priceInfo) {
  if (Array.isArray(priceInfo) && priceInfo.length) {
    const first = priceInfo[0];
    return first && typeof first === "object" ? first : {};
  }
  if (priceInfo && typeof priceInfo === "object") return priceInfo;
  return {};
}

function collectLivePriceSources(source) {
  const src = source && typeof source === "object" ? source : {};
  const priceInfo = normalizePriceInfo(src.price_info ?? src.priceInfo ?? src);
  const candidates = [src, priceInfo];
  return candidates.filter((entry, index) => entry && typeof entry === "object" && index === candidates.findIndex((x) => x === entry));
}

function resolveLiveBasePrice(source) {
  const sources = collectLivePriceSources(source);
  for (const entry of sources) {
    const value = pickFirstFiniteFromKeys(entry, [
      "original_price",
      "originalPrice",
      "inflated_price_of_original_price",
      "local_price",
      "model_original_price",
      "item_original_price",
      "price_before_discount",
      "input_normal_price",
      "normal_price",
      "list_price",
      "price",
    ]);
    if (value != null) return value;
  }
  return null;
}

function resolveLivePromotionPrice(source) {
  const sources = collectLivePriceSources(source);
  for (const entry of sources) {
    const value = pickFirstFiniteFromKeys(entry, [
      "promotion_price",
      "promo_price",
      "discount_price",
      "inflated_price_of_current_price",
      "local_promotion_price",
      "model_promotion_price",
      "item_promotion_price",
      "price_after_discount",
    ]);
    if (value != null) return value;
  }
  return null;
}

function resolveLiveCurrentPrice(source) {
  const sources = collectLivePriceSources(source);
  for (const entry of sources) {
    const value = pickFirstFiniteFromKeys(entry, [
      "current_price",
      "currentPrice",
      "price",
      "price_current",
    ]);
    if (value != null) return value;
  }
  return null;
}

function resolveLivePricePair(source) {
  const normalizedSource =
    source && typeof source === "object" ? source : {};
  const normalizedPriceInfo = normalizePriceInfo(
    normalizedSource.price_info ?? normalizedSource.priceInfo ?? normalizedSource,
  );
  const hasPromotion =
    Boolean(normalizedSource?.has_promotion) ||
    Boolean(normalizedSource?.hasPromotion) ||
    Boolean(normalizedPriceInfo?.has_promotion) ||
    Boolean(normalizedPriceInfo?.hasPromotion) ||
    toNumberOrZero(normalizedSource?.promotion_id) > 0 ||
    toNumberOrZero(normalizedSource?.promotionId) > 0 ||
    toNumberOrZero(normalizedPriceInfo?.promotion_id) > 0 ||
    toNumberOrZero(normalizedPriceInfo?.promotionId) > 0;
  const baseRaw = toFiniteNumberOrNull(resolveLiveBasePrice(source));
  const promoRaw = toFiniteNumberOrNull(resolveLivePromotionPrice(source));
  const currentRaw = toFiniteNumberOrNull(resolveLiveCurrentPrice(source));

  let basePrice = baseRaw;
  let promoPrice = promoRaw;

  if (basePrice == null && currentRaw != null) {
    basePrice = currentRaw;
  }

  if (promoPrice == null && basePrice != null && currentRaw != null && currentRaw < basePrice) {
    promoPrice = currentRaw;
  }
  if (promoPrice == null && hasPromotion && currentRaw != null) {
    promoPrice = currentRaw;
  }

  if (promoPrice != null && basePrice != null && promoPrice >= basePrice) {
    promoPrice = null;
  }

  return {
    basePrice: basePrice == null ? null : Number(basePrice),
    promoPrice: promoPrice == null ? null : Number(promoPrice),
  };
}

function resolveLiveSoldCount(source) {
  const sold = pickNumberFromKeys(source, [
    "sold",
    "sales",
    "historical_sold",
    "item_sold",
    "sold_count",
  ]);
  return Math.max(0, toNumberOrZero(sold));
}

async function withTimeout(promise, timeoutMs, fallbackValue) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 10000);
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), safeTimeout);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildLiveExportDataMap(shop, products = []) {
  const map = new Map();
  const itemIds = dedupPreserveOrder(
    (Array.isArray(products) ? products : [])
      .map((product) => String(product?.itemId || "").trim())
      .filter((itemId) => onlyDigits(itemId)),
  );

  if (!itemIds.length) return map;

  const liveItemIds =
    PRODUCT_EXPORT_LIVE_ITEM_LIMIT <= 0
      ? itemIds
      : itemIds.slice(0, PRODUCT_EXPORT_LIVE_ITEM_LIMIT);
  const liveItemIdSet = new Set(liveItemIds);

  for (const chunk of chunkArray(liveItemIds, 50)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await withTimeout(
        ShopeeProductService.getItemBaseInfo({
          shopId: String(shop.shopId),
          itemIdList: chunk,
        }),
        PRODUCT_EXPORT_LIVE_TIMEOUT_MS,
        null,
      );
      const rows =
        response?.response?.item_list ||
        response?.response?.items ||
        response?.response ||
        [];

      for (const row of Array.isArray(rows) ? rows : []) {
        const itemId = String(row?.item_id || "").trim();
        if (!onlyDigits(itemId)) continue;
        const livePrices = resolveLivePricePair(row);
        const logisticsInfo = buildShippingSnapshot(row?.logistic_info);
        map.set(itemId, {
          basePrice: livePrices.basePrice,
          promoPrice: livePrices.promoPrice,
          sold: resolveLiveSoldCount(row),
          shippingMode: logisticsInfo.shippingMode || null,
          shippingKinds: Array.isArray(logisticsInfo.shippingKinds)
            ? logisticsInfo.shippingKinds
            : [],
          spxEnabled: Boolean(logisticsInfo.spxEnabled),
          modelPriceByModelId: new Map(),
        });
      }
    } catch (_error) {
      // Se falhar consulta online, mantemos fallback local sem quebrar exportação.
    }
  }

  const modelItemIds = dedupPreserveOrder(
    (Array.isArray(products) ? products : [])
      .filter(
        (product) =>
          Boolean(product?.hasModel) &&
          liveItemIdSet.has(String(product?.itemId || "").trim()),
      )
      .map((product) => String(product?.itemId || "").trim())
      .filter((itemId) => onlyDigits(itemId)),
  );
  const modelLookupIds =
    PRODUCT_EXPORT_LIVE_MODEL_LIMIT <= 0
      ? modelItemIds
      : modelItemIds.slice(0, PRODUCT_EXPORT_LIVE_MODEL_LIMIT);

  const modelRows = await mapWithConcurrency(
    modelLookupIds,
    4,
    async (itemId) => {
      try {
        const response = await withTimeout(
          ShopeeProductService.getModelList({
            shopId: String(shop.shopId),
            itemId,
          }),
          PRODUCT_EXPORT_LIVE_TIMEOUT_MS,
          null,
        );
        const models = Array.isArray(response?.response?.model)
          ? response.response.model
          : [];
        return { itemId, models };
      } catch (_error) {
        return { itemId, models: [] };
      }
    },
  );

  for (const row of modelRows) {
    const itemId = String(row?.itemId || "").trim();
    if (!onlyDigits(itemId)) continue;
    const bucket = map.get(itemId) || {
      basePrice: null,
      promoPrice: null,
      shippingMode: null,
      shippingKinds: [],
      spxEnabled: false,
      modelPriceByModelId: new Map(),
    };
    if (!(bucket.modelPriceByModelId instanceof Map)) {
      bucket.modelPriceByModelId = new Map();
    }
    for (const model of Array.isArray(row?.models) ? row.models : []) {
      const modelId = String(model?.model_id || model?.modelId || "").trim();
      if (!modelId) continue;
      const livePrices = resolveLivePricePair(model);
      bucket.modelPriceByModelId.set(modelId, {
        basePrice: livePrices.basePrice,
        promoPrice: livePrices.promoPrice,
        sold: resolveLiveSoldCount(model),
      });
    }
    map.set(itemId, bucket);
  }

  return map;
}

function resolveLogisticsExportLabel({ shippingKinds = [], shippingMode = null } = {}) {
  const kinds = Array.isArray(shippingKinds)
    ? shippingKinds.map((kind) => String(kind || "").trim().toLowerCase())
    : [];
  const hasSpx = kinds.includes("spx");
  const hasSeller = kinds.includes("intelipost");

  if (hasSpx && hasSeller) return "Shopee Xpress + Logistica do vendedor";
  if (hasSpx) return "Shopee Xpress";
  if (hasSeller) return "Logistica do vendedor";
  if (shippingMode) return String(shippingMode);
  return "Nao identificado";
}

function toPositiveFiniteOrNull(value) {
  const parsed = toFiniteNumberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function resolvePackagingMetricsForExport(product) {
  const dimension = product?.dimension && typeof product.dimension === "object"
    ? product.dimension
    : {};
  const packageLength = toPositiveFiniteOrNull(
    dimension?.package_length ?? dimension?.packageLength ?? dimension?.length,
  );
  const packageWidth = toPositiveFiniteOrNull(
    dimension?.package_width ?? dimension?.packageWidth ?? dimension?.width,
  );
  const packageHeight = toPositiveFiniteOrNull(
    dimension?.package_height ?? dimension?.packageHeight ?? dimension?.height,
  );
  const packageWeight = toPositiveFiniteOrNull(
    product?.weight ?? product?.packageWeight,
  );
  const hasFullDimension = [packageLength, packageWidth, packageHeight].every(
    (value) => value != null,
  );
  const volumeCm3 = hasFullDimension
    ? Number((packageLength * packageWidth * packageHeight).toFixed(3))
    : null;

  const physicalAnalysis = analyzeSpxPhysicalEligibility({
    dimension: {
      package_length: packageLength,
      package_width: packageWidth,
      package_height: packageHeight,
    },
    weight: packageWeight,
  });

  return {
    packageLength,
    packageWidth,
    packageHeight,
    packageWeight,
    volumeCm3,
    cubicWeight: toFiniteNumberOrNull(physicalAnalysis?.metrics?.cubicWeight),
    chargeableWeight: toFiniteNumberOrNull(
      physicalAnalysis?.metrics?.chargeableWeight,
    ),
    spxPhysicalEligible: Boolean(physicalAnalysis?.eligible),
    spxPhysicalReasons: Array.isArray(physicalAnalysis?.reasons)
      ? physicalAnalysis.reasons
      : [],
  };
}

function buildSpxWeightCubageValidationLabel(metrics = {}) {
  if (metrics.spxPhysicalEligible) return "Elegivel";
  const reasons = Array.isArray(metrics.spxPhysicalReasons)
    ? metrics.spxPhysicalReasons
    : [];
  if (!reasons.length) return "Nao elegivel";
  return `Nao elegivel: ${reasons.join(" | ")}`;
}

function extractPackageVolumesFromDescription(description) {
  const originalText = String(description || "").trim();
  if (!originalText) {
    return {
      boxesCount: null,
      summary: "Nao identificado",
    };
  }

  const normalized = originalText
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const candidates = [];
  const patterns = [
    /(?:^|[\s,;:()\-])(\d{1,4})\s*(?:x|un(?:idades?)?\s*de)?\s*(?:caixas?|caixotes?|cxs?|cx|volumes?|vols?|vol|pacotes?|pcts?|embalagens?)(?=$|[\s,;:()\-])/g,
    /(?:^|[\s,;:()\-])(?:caixas?|caixotes?|cxs?|cx|volumes?|vols?|vol|pacotes?|pcts?|embalagens?)\s*(?:[:=\-]|com)?\s*(\d{1,4})(?=$|[\s,;:()\-])/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const parsed = Number(match?.[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        candidates.push(parsed);
      }
    }
  }

  if (!candidates.length) {
    return {
      boxesCount: null,
      summary: "Nao identificado",
    };
  }

  const boxesCount = Math.max(...candidates);
  return {
    boxesCount,
    summary: `${boxesCount} caixa(s)/volume(s)`,
  };
}

function startOfDayUtc(raw) {
  if (!raw) return null;
  const date = new Date(`${String(raw).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endOfDayUtc(raw) {
  if (!raw) return null;
  const date = new Date(`${String(raw).slice(0, 10)}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRangeDaysInclusive(start, end) {
  const diff = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

function buildRangeFromQuery(req, defaultDays = 30) {
  const requestedStart = startOfDayUtc(req.query?.dateFrom);
  const requestedEnd = endOfDayUtc(req.query?.dateTo);

  if (requestedStart && requestedEnd && requestedStart <= requestedEnd) {
    return { start: requestedStart, end: requestedEnd };
  }

  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (Math.max(1, Number(defaultDays) || 30) - 1));
  start.setUTCHours(0, 0, 0, 0);
  return { start, end };
}

function buildPreviousRange(start, end) {
  const spanMs = end.getTime() - start.getTime() + 1;
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - spanMs + 1);
  return { start: previousStart, end: previousEnd };
}

function toAmsDateYyyyMmDd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseBooleanFlag(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "sim";
}

function pickNumberFromKeys(source, keys = []) {
  const data = source && typeof source === "object" ? source : {};
  for (const key of keys) {
    const value = data[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickTextFromKeys(source, keys = []) {
  const data = source && typeof source === "object" ? source : {};
  for (const key of keys) {
    const value = String(data[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function extractAmsProductPerformanceRows(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const candidates = [
    root?.response,
    root?.result?.response,
    root?.data,
    root?.result?.data,
    root,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const possibleArrays = [
      candidate?.item_list,
      candidate?.items,
      candidate?.list,
      candidate?.rows,
      candidate?.performance_list,
      candidate?.product_list,
    ];
    for (const list of possibleArrays) {
      if (Array.isArray(list)) return list;
    }
  }

  return [];
}

function normalizeSalesControlPerformanceRow(row, localFallback = null) {
  const source = row && typeof row === "object" ? row : {};
  const local = localFallback && typeof localFallback === "object" ? localFallback : {};

  const itemIdRaw =
    pickTextFromKeys(source, ["item_id", "itemId", "product_id", "productId", "id"]) ||
    String(local?.itemId || "").trim();

  if (!onlyDigits(itemIdRaw)) return null;

  const impressionsRaw = pickNumberFromKeys(source, [
    "impression",
    "impressions",
    "impression_count",
    "impressionCount",
    "exposure",
    "exposure_count",
    "view_count",
    "views",
    "pv",
    "page_views",
  ]);
  const visitsRaw = pickNumberFromKeys(source, [
    "visit",
    "visits",
    "click",
    "clicks",
    "visitor",
    "visitors",
    "uv",
    "unique_visitor",
    "viewers",
  ]);
  const ordersRaw = pickNumberFromKeys(source, [
    "order",
    "orders",
    "order_count",
    "confirmed_order",
    "confirmedOrder",
    "paid_order",
    "paidOrder",
  ]);
  const soldRaw = pickNumberFromKeys(source, [
    "sold",
    "sales",
    "sales_count",
    "item_sold",
    "items_sold",
    "quantity",
  ]);
  const conversionRaw = pickNumberFromKeys(source, [
    "conversion_rate",
    "conversionRate",
    "conversion",
    "cvr",
    "cv_rate",
  ]);

  const impressions = Math.max(0, toNumberOrZero(impressionsRaw));
  const visits = Math.max(0, toNumberOrZero(visitsRaw));
  const orders = Math.max(
    0,
    toNumberOrZero(
      ordersRaw != null ? ordersRaw : local?.orders,
    ),
  );
  const sold = Math.max(
    0,
    toNumberOrZero(
      soldRaw != null ? soldRaw : local?.quantity,
    ),
  );
  const revenue = toNumberOrZero(local?.revenueCents) / 100;

  let conversionPct = null;
  if (Number.isFinite(Number(conversionRaw))) {
    const raw = Number(conversionRaw);
    conversionPct = raw <= 1 ? raw * 100 : raw;
  } else if (visits > 0) {
    const base = sold > 0 ? sold : orders;
    conversionPct = (base / visits) * 100;
  }

  return {
    itemId: itemIdRaw,
    title:
      pickTextFromKeys(source, ["item_name", "itemName", "title", "name"]) ||
      String(local?.title || "").trim() ||
      `Item ${itemIdRaw}`,
    impressions,
    visits,
    sold,
    orders,
    conversionPct:
      conversionPct == null ? 0 : Number(Math.max(0, conversionPct).toFixed(2)),
    revenue: Number(revenue.toFixed(2)),
  };
}

function readSalesControlOrganicCache(shopDbId, itemId) {
  const key = `${String(shopDbId || "").trim()}:${String(itemId || "").trim()}`;
  if (!key || key === ":") return null;
  const entry = SALES_CONTROL_ORGANIC_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.cachedAt || 0) > SALES_CONTROL_ORGANIC_CACHE_TTL_MS) {
    SALES_CONTROL_ORGANIC_CACHE.delete(key);
    return null;
  }
  return entry.value || null;
}

function writeSalesControlOrganicCache(shopDbId, itemId, value) {
  const key = `${String(shopDbId || "").trim()}:${String(itemId || "").trim()}`;
  if (!key || key === ":") return;
  SALES_CONTROL_ORGANIC_CACHE.set(key, {
    cachedAt: Date.now(),
    value,
  });
}

function extractOrganicTrafficFromItemExtraInfo(itemId, payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const response = root?.response || root?.result?.response || root?.data || {};

  const responseItemLists = [
    Array.isArray(response?.item_list) ? response.item_list : [],
    Array.isArray(response?.item_extra_info_list) ? response.item_extra_info_list : [],
    Array.isArray(response?.items) ? response.items : [],
  ];
  const responseItem = responseItemLists
    .flat()
    .find((entry) => String(entry?.item_id || entry?.itemId || "").trim() === String(itemId));

  const source = responseItem || response?.item || response;
  const impressionsRaw = pickNumberFromKeys(source, [
    "impression",
    "impressions",
    "impression_count",
    "exposure",
    "exposure_count",
    "view_count",
    "views",
    "pv",
    "page_views",
    "detail_views",
  ]);
  const visitsRaw = pickNumberFromKeys(source, [
    "visit",
    "visits",
    "visitor",
    "visitors",
    "uv",
    "unique_visitor",
    "unique_visitors",
  ]);
  const clicksRaw = pickNumberFromKeys(source, [
    "click",
    "clicks",
    "detail_click",
    "detail_clicks",
    "ctr_click",
  ]);

  const views = Math.max(0, toNumberOrZero(impressionsRaw));
  const visits = Math.max(
    0,
    toNumberOrZero(visitsRaw != null ? visitsRaw : impressionsRaw),
  );
  const clicks = Math.max(0, toNumberOrZero(clicksRaw));

  return {
    views,
    impressions: views,
    visits,
    clicks,
  };
}

async function fetchItemExtraInfoMap(shop, itemIds = []) {
  const normalizedIds = dedupPreserveOrder(
    (Array.isArray(itemIds) ? itemIds : [])
      .map((itemId) => String(itemId || "").trim())
      .filter((itemId) => onlyDigits(itemId)),
  );
  if (!normalizedIds.length) return new Map();

  const map = new Map();
  for (const batch of chunk(normalizedIds, 50)) {
    // eslint-disable-next-line no-await-in-loop
    const response = await ShopeeProductService.getItemExtraInfoBatch({
      shopId: String(shop.shopId),
      itemIdList: batch,
    });

    const responseRoot =
      response?.response && typeof response.response === "object"
        ? response.response
        : response;
    const itemList = [
      ...(Array.isArray(responseRoot?.item_list) ? responseRoot.item_list : []),
      ...(Array.isArray(responseRoot?.item_extra_info_list)
        ? responseRoot.item_extra_info_list
        : []),
    ];
    for (const row of itemList) {
      const itemId = String(row?.item_id || row?.itemId || "").trim();
      if (!onlyDigits(itemId)) continue;
      const views = Math.max(0, toNumberOrZero(row?.views));
      const visits = Math.max(
        0,
        toNumberOrZero(
          pickNumberFromKeys(row, [
            "visit",
            "visits",
            "visitor",
            "visitors",
            "uv",
            "unique_visitor",
          ]),
        ),
      );
      const clicks = Math.max(
        0,
        toNumberOrZero(
          pickNumberFromKeys(row, [
            "click",
            "clicks",
            "detail_click",
            "detail_clicks",
          ]),
        ),
      );
      map.set(itemId, {
        views,
        visits: visits || views,
        clicks,
        likes: Math.max(0, toNumberOrZero(row?.likes)),
        sale: Math.max(0, toNumberOrZero(row?.sale)),
        commentCount: Math.max(0, toNumberOrZero(row?.comment_count)),
        ratingStar: toFiniteNumberOrNull(row?.rating_star),
      });
    }
  }

  return map;
}

async function loadOrganicTrafficMapForSalesControl(
  shop,
  itemIds = [],
  rangeStart = null,
  rangeEnd = null,
) {
  const normalizedIds = dedupPreserveOrder(
    (Array.isArray(itemIds) ? itemIds : [])
      .map((itemId) => String(itemId || "").trim())
      .filter((itemId) => onlyDigits(itemId)),
  );

  const targetIds = normalizedIds.slice(0, SALES_CONTROL_ORGANIC_FETCH_LIMIT);
  const truncated = normalizedIds.length > targetIds.length;
  const trafficMap = new Map();
  const warningMessages = [];

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);

  let historicalHits = 0;
  let historyAvailable = true;
  let includesToday = true;
  let trackedTodayCount = 0;

  const validStart =
    rangeStart instanceof Date && !Number.isNaN(rangeStart.getTime())
      ? rangeStart
      : null;
  const validEnd =
    rangeEnd instanceof Date && !Number.isNaN(rangeEnd.getTime()) ? rangeEnd : null;

  if (validStart && validEnd) {
    const startKey = validStart.toISOString().slice(0, 10);
    const endKey = validEnd.toISOString().slice(0, 10);
    includesToday = startKey <= todayKey && todayKey <= endKey;
  }

  if (targetIds.length && validStart && validEnd) {
    try {
      const historyRows = await listAggregatedProductTrafficDailyByRange(
        shop.id,
        validStart,
        validEnd,
        targetIds,
      );
      for (const row of Array.isArray(historyRows) ? historyRows : []) {
        let itemId = "";
        try {
          itemId = String(
            row?.itemId != null && typeof row.itemId === "bigint"
              ? row.itemId
              : BigInt(String(row?.itemId || "")),
          );
        } catch (_error) {
          itemId = "";
        }
        if (!onlyDigits(itemId)) continue;

        const impressions = Math.max(0, toNumberOrZero(row?.impressions));
        const visits = Math.max(0, toNumberOrZero(row?.visits));
        if (impressions > 0 || visits > 0) {
          historicalHits += 1;
        }
        trafficMap.set(itemId, {
          impressions,
          visits,
        });
      }
    } catch (error) {
      historyAvailable = false;
      warningMessages.push(
        `Historico diario indisponivel (${parseShopeeErrorMessage(error)})`,
      );
    }
  }

  const trackedTodaySet = new Set();
  if (includesToday && historyAvailable && targetIds.length) {
    try {
      const trackedTodayIds = await listTrackedItemIdsForDate(shop.id, todayKey, targetIds);
      for (const itemId of Array.isArray(trackedTodayIds) ? trackedTodayIds : []) {
        const normalized = String(itemId || "").trim();
        if (onlyDigits(normalized)) trackedTodaySet.add(normalized);
      }
      trackedTodayCount = trackedTodaySet.size;
    } catch (error) {
      warningMessages.push(
        `Falha ao consultar snapshot diario de hoje (${parseShopeeErrorMessage(error)})`,
      );
    }
  }

  const toFetch = [];
  const upsertCandidates = [];
  let cacheHits = 0;

  for (const itemId of targetIds) {
    const cached = readSalesControlOrganicCache(shop.id, itemId);
    if (cached && typeof cached === "object") {
      cacheHits += 1;
      const cachedImpressions = Math.max(0, toNumberOrZero(cached.impressions));
      const cachedVisits = Math.max(0, toNumberOrZero(cached.visits));

      if (!historyAvailable) {
        if (cachedImpressions > 0 || cachedVisits > 0) {
          trafficMap.set(itemId, {
            impressions: cachedImpressions,
            visits: cachedVisits,
          });
          continue;
        }
      } else {
        if (includesToday && !trackedTodaySet.has(itemId)) {
          upsertCandidates.push({
            itemId,
            impressionsCumulative: cachedImpressions,
            visitsCumulative: cachedVisits,
            source: "cache_item_extra_info",
          });
        }
        continue;
      }
    }

    if (historyAvailable && (!includesToday || trackedTodaySet.has(itemId))) {
      continue;
    }
    toFetch.push(itemId);
  }

  let firstErrorMessage = "";
  const fetchedRows = [];
  for (const batch of chunk(toFetch, 50)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getItemExtraInfoBatch({
        shopId: String(shop.shopId),
        itemIdList: batch,
      });
      const responseList = Array.isArray(response?.response?.item_list)
        ? response.response.item_list
        : [];
      const responseById = new Map(
        responseList.map((entry) => [String(entry?.item_id || "").trim(), entry]),
      );

      for (const itemId of batch) {
        const row = responseById.get(String(itemId)) || null;
        const metric = extractOrganicTrafficFromItemExtraInfo(itemId, {
          response: { item_list: row ? [row] : [] },
        });
        writeSalesControlOrganicCache(shop.id, itemId, metric);
        fetchedRows.push({ itemId, ...metric, failed: false });
      }
    } catch (error) {
      if (!firstErrorMessage) {
        firstErrorMessage = parseShopeeErrorMessage(error);
      }
      for (const itemId of batch) {
        fetchedRows.push({
          itemId,
          impressions: 0,
          visits: 0,
          failed: true,
        });
      }
    }
  }

  for (const row of fetchedRows) {
    if (!row?.itemId || row.failed) continue;
    if (historyAvailable && includesToday) {
      upsertCandidates.push({
        itemId: String(row.itemId),
        impressionsCumulative: Math.max(0, toNumberOrZero(row.impressions)),
        visitsCumulative: Math.max(0, toNumberOrZero(row.visits)),
        source: "item_extra_info",
      });
      continue;
    }
    trafficMap.set(String(row.itemId), {
      impressions: Math.max(0, toNumberOrZero(row.impressions)),
      visits: Math.max(0, toNumberOrZero(row.visits)),
    });
  }

  let persistedTodayCount = 0;
  if (includesToday && historyAvailable && upsertCandidates.length) {
    try {
      const persistedRows = await upsertProductTrafficDailySnapshots(
        shop.id,
        todayKey,
        upsertCandidates,
      );

      for (const row of Array.isArray(persistedRows) ? persistedRows : []) {
        let itemId = "";
        try {
          itemId = String(
            row?.itemId != null && typeof row.itemId === "bigint"
              ? row.itemId
              : BigInt(String(row?.itemId || "")),
          );
        } catch (_error) {
          itemId = "";
        }
        if (!onlyDigits(itemId)) continue;
        const current = trafficMap.get(itemId) || { impressions: 0, visits: 0 };
        trafficMap.set(itemId, {
          impressions:
            Math.max(0, toNumberOrZero(current.impressions)) +
            Math.max(0, toNumberOrZero(row?.impressionsDelta)),
          visits:
            Math.max(0, toNumberOrZero(current.visits)) +
            Math.max(0, toNumberOrZero(row?.visitsDelta)),
        });
        persistedTodayCount += 1;
      }
    } catch (error) {
      warningMessages.push(
        `Falha ao persistir snapshot diario (${parseShopeeErrorMessage(error)})`,
      );
    }
  }

  if (firstErrorMessage) {
    warningMessages.push(
      `Nao foi possivel consultar trafego organico de alguns itens (${firstErrorMessage})`,
    );
  }

  return {
    trafficMap,
    fetchedCount: toFetch.length,
    cacheHits,
    truncated,
    historicalHits,
    includesToday,
    trackedTodayCount,
    persistedTodayCount,
    warning: warningMessages.join(" | "),
  };
}

function pctGrowth(currentValue, previousValue) {
  const current = toNumberOrZero(currentValue);
  const previous = toNumberOrZero(previousValue);

  if (previous <= 0 && current <= 0) return 0;
  if (previous <= 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function mapMetricsByProductId(rows = []) {
  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        revenueCents: toNumberOrZero(row.revenueCents),
        orders: toNumberOrZero(row.orders),
        quantity: toNumberOrZero(row.quantity),
      },
    ]),
  );
}

function normalizeDateLabel(date) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch (_error) {
    return date.toISOString().slice(0, 10);
  }
}

function getCachedCategoryByItemId(itemId) {
  const key = String(itemId || "").trim();
  if (!key) return null;
  const entry = SALES_CATEGORY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.cachedAt || 0) > SALES_CATEGORY_CACHE_TTL_MS) {
    SALES_CATEGORY_CACHE.delete(key);
    return null;
  }
  return String(entry.categoryId || "").trim() || null;
}

function cacheCategoryByItemId(itemId, categoryId) {
  const key = String(itemId || "").trim();
  const value = String(categoryId || "").trim();
  if (!key || !value) return;
  SALES_CATEGORY_CACHE.set(key, {
    categoryId: value,
    cachedAt: Date.now(),
  });
}

function chunkArray(list = [], size = 50) {
  const arr = Array.isArray(list) ? list : [];
  const chunkSize = Math.max(1, Number(size) || 50);
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

async function enrichRowsWithLiveCategoryIds(shop, rows = []) {
  if (!shop?.shopId) return rows;
  const baseRows = Array.isArray(rows) ? rows : [];
  if (!baseRows.length) return baseRows;

  const pendingItemIds = dedupPreserveOrder(
    baseRows
      .filter((row) => !onlyDigits(row?.categoryId) && onlyDigits(row?.itemId))
      .map((row) => String(row.itemId || "").trim()),
  );

  if (!pendingItemIds.length) return baseRows;

  const categoryByItemId = new Map();
  const unresolvedItemIds = [];

  pendingItemIds.forEach((itemId) => {
    const cached = getCachedCategoryByItemId(itemId);
    if (onlyDigits(cached)) {
      categoryByItemId.set(itemId, cached);
    } else {
      unresolvedItemIds.push(itemId);
    }
  });

  if (unresolvedItemIds.length) {
    const chunks = chunkArray(unresolvedItemIds, 50);
    const responses = await mapWithConcurrency(chunks, 2, async (chunk) => {
      try {
        return await ShopeeProductService.getItemBaseInfo({
          shopId: String(shop.shopId),
          itemIdList: chunk,
        });
      } catch (_error) {
        return null;
      }
    });

    responses.forEach((response) => {
      const items = Array.isArray(response?.response?.item_list)
        ? response.response.item_list
        : [];
      items.forEach((item) => {
        const itemId = String(item?.item_id || "").trim();
        const categoryId = String(item?.category_id || "").trim();
        if (!onlyDigits(itemId) || !onlyDigits(categoryId)) return;
        categoryByItemId.set(itemId, categoryId);
        cacheCategoryByItemId(itemId, categoryId);
      });
    });
  }

  return baseRows.map((row) => {
    if (onlyDigits(row?.categoryId)) return row;
    const itemId = String(row?.itemId || "").trim();
    const categoryId = categoryByItemId.get(itemId);
    if (!onlyDigits(categoryId)) return row;
    return {
      ...row,
      categoryId,
    };
  });
}

function resolveAbcMetricMode(rawMode) {
  const mode = String(rawMode || "revenue")
    .trim()
    .toLowerCase();
  if (mode === "orders" || mode === "quantity") return "orders";
  return "revenue";
}

function buildCurvesFromSalesRows(rows = [], mode = "revenue") {
  const selectedMode = resolveAbcMetricMode(mode);
  const metricField = selectedMode === "orders" ? "orders" : "revenueCents";
  const metricLabel =
    selectedMode === "orders" ? "quantidade de pedidos" : "faturamento";
  const metricLabelPlural =
    selectedMode === "orders" ? "pedidos" : "faturamento";

  const totalRevenueCents = rows.reduce(
    (total, row) => total + toNumberOrZero(row.revenueCents),
    0,
  );
  const totalMetric = rows.reduce(
    (total, row) => total + toNumberOrZero(row[metricField]),
    0,
  );
  let cumulativePct = 0;

  const curves = {
    A: {
      label: "Curva A - Maior participacao",
      description: `Itens que concentram ate 80% da ${metricLabel}.`,
      count: 0,
      products: [],
    },
    B: {
      label: "Curva B - Participacao intermediaria",
      description: `Itens que levam o acumulado de ${metricLabelPlural} entre 80% e 95%.`,
      count: 0,
      products: [],
    },
    C: {
      label: "Curva C - Cauda longa",
      description: `Itens restantes com menor participacao na ${metricLabel}.`,
      count: 0,
      products: [],
    },
  };

  rows.forEach((row, index) => {
    const selectedMetricValue = toNumberOrZero(row[metricField]);
    const sharePct =
      totalMetric > 0
        ? Number(((selectedMetricValue / totalMetric) * 100).toFixed(2))
        : 0;
    cumulativePct += sharePct;

    let curveKey = "C";
    if (index === 0 || cumulativePct <= 80) {
      curveKey = "A";
    } else if (cumulativePct <= 95) {
      curveKey = "B";
    }

    curves[curveKey].products.push({
      ...row,
      curve: curveKey,
      abcMode: selectedMode,
      shareMetricPct: sharePct,
      cumulativeMetricPct: Number(cumulativePct.toFixed(2)),
      selectedMetricValue,
      shareRevenuePct: sharePct,
      cumulativeRevenuePct: Number(cumulativePct.toFixed(2)),
    });
  });

  Object.values(curves).forEach((curve) => {
    curve.count = curve.products.length;
  });

  return {
    abcMode: selectedMode,
    metricField,
    metricLabel,
    metricLabelPlural,
    totalMetric,
    totalRevenueCents,
    curves,
  };
}

function getProductLaunchDate(product) {
  return product?.shopeeCreateTime || product?.createdAt || null;
}

function buildLaunchQuality(product) {
  const attrs = Array.isArray(product?.attributes) ? product.attributes : [];
  const filledAttrs = attrs.filter((attr) => {
    const values = Array.isArray(attr?.attribute_value_list)
      ? attr.attribute_value_list
          .map(
            (value) =>
              value?.original_value_name ||
              value?.value_name ||
              value?.value ||
              "",
          )
          .filter(Boolean)
      : [];
    return values.length > 0;
  });
  const titleLength = String(product?.title || "").trim().length;
  const imageCount = Array.isArray(product?.images) ? product.images.length : 0;
  const brandFilled = Boolean(String(product?.brand || "").trim());
  const enoughAttrs = filledAttrs.length >= 5;
  const enoughImages = imageCount >= 4;
  const titleOptimal = titleLength >= 80 && titleLength <= 100;

  let score = 100;
  if (!brandFilled) score -= 15;
  if (!enoughAttrs) score -= 20;
  if (!enoughImages) score -= 15;
  if (!titleOptimal) score -= 15;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    checks: {
      brandFilled,
      enoughAttrs,
      enoughImages,
      titleOptimal,
    },
    metrics: {
      titleLength,
      imageCount,
      filledAttributeCount: filledAttrs.length,
    },
  };
}

async function persistImagesFromUpdateItemResponse(productId, updated) {
  const images = updated?.response?.images || updated?.images || null;
  const idList = Array.isArray(images?.image_id_list) ? images.image_id_list : [];
  const urlList = Array.isArray(images?.image_url_list)
    ? images.image_url_list
    : [];

  if (!idList.length && !urlList.length) return;

  const rows = [];
  const total = Math.max(idList.length, urlList.length);
  for (let index = 0; index < total; index += 1) {
    const imageId = idList[index] ? String(idList[index]) : null;
    const url = urlList[index] ? String(urlList[index]) : null;
    if (!url && !imageId) continue;
    rows.push({ url: url || "", imageId });
  }

  await replaceProductImages(productId, rows);
}

function buildShippingSnapshot(rawLogistics) {
  const analysis = analyzeLogistics(rawLogistics);

  return {
    shippingMode: analysis.shippingMode,
    shippingChannels: analysis.shippingChannels,
    shippingKinds: analysis.shippingKinds,
    spxEnabled: analysis.spxEnabled,
    spxEligible: analysis.spxEligible,
  };
}

function buildPromotionLockPayload(lockEntry, now = new Date()) {
  if (!lockEntry?.lockUntil) {
    return {
      isBlockedNow: false,
      lockUntil: null,
      remainingMs: 0,
      remainingLabel: "Liberado",
    };
  }

  const lockUntilDate = new Date(lockEntry.lockUntil);
  const remaining = formatRemainingFromLock(lockUntilDate, now);
  return {
    isBlockedNow: remaining.isBlocked,
    lockUntil: lockEntry.lockUntil,
    remainingMs: remaining.remainingMs,
    remainingLabel: remaining.remainingLabel,
  };
}

async function list(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const pageRaw = Number(req.query.page || 1);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  const pageSizeRaw =
    req.query.pageSize != null ? Number(req.query.pageSize) : null;
  const usingLegacyLimit =
    req.query.page == null &&
    req.query.pageSize == null &&
    req.query.limit != null;
  const legacyLimitRaw = usingLegacyLimit ? Number(req.query.limit) : null;

  let pageSize;
  if (usingLegacyLimit) {
    pageSize = Math.min(200, Math.max(1, Math.floor(legacyLimitRaw || 60)));
  } else if ([25, 50, 100].includes(pageSizeRaw)) {
    pageSize = pageSizeRaw;
  } else {
    pageSize = 50;
  }

  const skip = (page - 1) * pageSize;
  const q = String(req.query.q || "").trim();
  const sortBy = String(req.query.sortBy || "updatedAt");
  const sortDir = String(req.query.sortDir || "desc") === "asc" ? "asc" : "desc";
  const includeInactiveRaw = String(req.query.includeInactive || "").trim().toLowerCase();
  const includeInactiveRequested =
    includeInactiveRaw === "1" ||
    includeInactiveRaw === "true" ||
    includeInactiveRaw === "yes";
  const statusFilters = parseProductStatusFilters(req.query.status ?? req.query.statuses);
  const skuFilters = parseSkuFilters(req.query.skus ?? req.query.skuList);
  const includeInactive = includeInactiveRequested || statusFilters.length > 0;

  const total = await countProductsForManagement(shop.id, {
    q,
    includeInactive,
    statuses: statusFilters,
    skuList: skuFilters,
  });

  const sortByNormalized = String(sortBy || "").trim().toLowerCase();
  const trafficSortField =
    sortByNormalized === "visits30d" || sortByNormalized === "visits"
      ? "visits30d"
      : sortByNormalized === "likes30d" || sortByNormalized === "likes"
        ? "likes30d"
        : sortByNormalized === "views30d" || sortByNormalized === "views"
          ? "views30d"
          : null;
  const shouldSortByTraffic = Boolean(trafficSortField);

  let rows = [];
  let itemExtraInfoMap = new Map();

  if (total > 0) {
    if (shouldSortByTraffic) {
      const allRows = await listProductsForManagement(shop.id, {
        q,
        // Mantemos ordem base determinística antes do sort por tráfego.
        sortBy: "updatedAt",
        sortDir: "desc",
        skip: 0,
        take: total,
        includeInactive,
        statuses: statusFilters,
        skuList: skuFilters,
      });

      try {
        itemExtraInfoMap = await fetchItemExtraInfoMap(
          shop,
          allRows.map((product) => product?.itemId),
        );
      } catch (_error) {
        itemExtraInfoMap = new Map();
      }

      const direction = sortDir === "asc" ? 1 : -1;
      const metricOf = (product) => {
        const itemId = String(product?.itemId || "").trim();
        const extra = itemExtraInfoMap.get(itemId) || null;
        if (trafficSortField === "likes30d") {
          return Math.max(0, toNumberOrZero(extra?.likes));
        }
        if (trafficSortField === "views30d") {
          return Math.max(0, toNumberOrZero(extra?.views));
        }
        return Math.max(
          0,
          toNumberOrZero(extra?.visits != null ? extra.visits : extra?.views),
        );
      };

      rows = allRows
        .map((product, index) => ({
          ...product,
          __trafficMetric: metricOf(product),
          __stableIndex: index,
        }))
        .sort((a, b) => {
          const metricDiff = (a.__trafficMetric - b.__trafficMetric) * direction;
          if (metricDiff !== 0) return metricDiff;

          const updatedAtA = new Date(a.updatedAt || 0).getTime();
          const updatedAtB = new Date(b.updatedAt || 0).getTime();
          if (updatedAtA !== updatedAtB) return updatedAtB - updatedAtA;

          const itemIdA = String(a.itemId || "");
          const itemIdB = String(b.itemId || "");
          if (itemIdA !== itemIdB) return itemIdA.localeCompare(itemIdB);

          return a.__stableIndex - b.__stableIndex;
        })
        .slice(skip, skip + pageSize)
        .map(({ __trafficMetric, __stableIndex, ...product }) => product);
    } else {
      rows = await listProductsForManagement(shop.id, {
        q,
        sortBy,
        sortDir,
        skip,
        take: pageSize,
        includeInactive,
        statuses: statusFilters,
        skuList: skuFilters,
      });

      try {
        itemExtraInfoMap = await fetchItemExtraInfoMap(
          shop,
          rows.map((product) => product?.itemId),
        );
      } catch (_error) {
        itemExtraInfoMap = new Map();
      }
    }
  }

  const soldFallbackMap = await mapSoldQuantityByItemIds(
    shop.id,
    rows.map((product) => product?.itemId),
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = rows.map((product) => {
    const totalStock = product.hasModel ? product.modelsStock : product.stock ?? null;
    const baseSold = toFiniteNumberOrNull(product.sold);
    const modelSold = toFiniteNumberOrNull(product.modelsSold) ?? 0;
    const localSoldFallback = Number(
      soldFallbackMap.get(String(product?.itemId || "")) || 0,
    );
    const sold = Math.max(
      0,
      baseSold ?? 0,
      modelSold,
      localSoldFallback,
    );

    const basePriceMin = toFiniteNumberOrNull(product.priceMin);
    const basePriceMax = toFiniteNumberOrNull(product.priceMax);
    const modelPriceMin = toFiniteNumberOrNull(product.modelPriceMin);
    const modelPriceMax = toFiniteNumberOrNull(product.modelPriceMax);

    let priceMin = null;
    let priceMax = null;
    if (product.hasModel) {
      priceMin = modelPriceMin ?? basePriceMin;
      priceMax = modelPriceMax ?? basePriceMax;
    } else {
      priceMin = basePriceMin ?? modelPriceMin;
      priceMax = basePriceMax ?? modelPriceMax;
    }
    if (priceMin == null && priceMax != null) priceMin = priceMax;
    if (priceMax == null && priceMin != null) priceMax = priceMin;

    const { modelsStock, logistics, ...rest } = product;
    const itemId = String(product?.itemId || "").trim();
    const extra = itemExtraInfoMap.get(itemId) || null;
    const views30d = Math.max(0, toNumberOrZero(extra?.views));
    const impressions30d = views30d;
    const visits30d = Math.max(
      0,
      toNumberOrZero(extra?.visits || extra?.views),
    );
    const likes30d = Math.max(0, toNumberOrZero(extra?.likes));
    const comments30d = Math.max(0, toNumberOrZero(extra?.commentCount));
    const clicks30d = Math.max(0, toNumberOrZero(extra?.clicks));
    return {
      ...rest,
      sold,
      priceMin,
      priceMax,
      totalStock,
      impressions30d,
      visits30d,
      views30d,
      likes30d,
      comments30d,
      clicks30d,
      ...buildShippingSnapshot(logistics),
    };
  });

  const lockMap = await listActivePriceLocksSafe(
    shop.id,
    items.map((item) => item?.itemId),
    new Date(),
  );
  const now = new Date();
  const itemsWithLocks = items.map((item) => {
    const lockEntry = lockMap.get(String(item?.itemId || ""));
    return {
      ...item,
      promotionLock: buildPromotionLockPayload(lockEntry, now),
    };
  });

  res.json({
    items: itemsWithLocks,
    meta: {
      page,
      pageSize,
      total,
      totalPages,
      filters: {
        includeInactive,
        statuses: statusFilters,
        skus: skuFilters,
      },
    },
  });
}

async function exportFiltered(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const q = String(req.query.q || "").trim();
  const includeInactiveRaw = String(req.query.includeInactive || "").trim().toLowerCase();
  const includeInactiveRequested =
    includeInactiveRaw === "1" ||
    includeInactiveRaw === "true" ||
    includeInactiveRaw === "yes";
  const statusFilters = parseProductStatusFilters(req.query.status ?? req.query.statuses);
  const skuFilters = parseSkuFilters(req.query.skus ?? req.query.skuList);
  const includeInactive = includeInactiveRequested || statusFilters.length > 0;

  const products = await listProductsForManagementExport(shop.id, {
    q,
    includeInactive,
    statuses: statusFilters,
    skuList: skuFilters,
  });
  const soldFallbackMap = await mapSoldQuantityByItemIds(
    shop.id,
    products.map((product) => product?.itemId),
  );
  const lockMap = await listActivePriceLocksSafe(
    shop.id,
    products.map((product) => product?.itemId),
    new Date(),
  );
  const lockNow = new Date();
  const shouldUseLiveExportData =
    PRODUCT_EXPORT_LIVE_MAX_PRODUCTS <= 0 || products.length <= PRODUCT_EXPORT_LIVE_MAX_PRODUCTS;
  const liveExportDataMap = shouldUseLiveExportData
    ? await buildLiveExportDataMap(shop, products)
    : new Map();

  const rows = [];
  for (const product of products) {
    const productStatus = String(product?.status || "").trim() || "UNKNOWN";
    const productName = String(product?.title || "").trim() || "Produto sem titulo";
    const productId = String(product?.itemId || "").trim();
    const productSku = String(product?.itemSku || "").trim();
    const productLockEntry = lockMap.get(productId);
    const productPromotionLock = buildPromotionLockPayload(productLockEntry, lockNow);
    const fallbackStock = resolveProductTotalStock(product);
    const liveExportData = liveExportDataMap.get(productId) || null;
    const productBasePriceLocal = resolveProductPriceForExport(product, null);
    const productPromotionPriceLocal = resolvePromotionPriceForExport(product, null);
    let productBasePrice =
      toFiniteNumberOrNull(liveExportData?.basePrice) ?? productBasePriceLocal;
    const productPromotionPrice =
      toFiniteNumberOrNull(liveExportData?.promoPrice) ?? productPromotionPriceLocal;
    const normalizedProductPromotionPrice =
      productPromotionPrice != null &&
      (productBasePrice == null || productPromotionPrice <= productBasePrice)
        ? productPromotionPrice
        : null;
    const productSellingPrice =
      normalizedProductPromotionPrice != null
        ? normalizedProductPromotionPrice
        : productBasePrice;
    if (
      normalizedProductPromotionPrice != null &&
      productBasePrice != null &&
      Number(productBasePrice) === Number(productSellingPrice)
    ) {
      productBasePrice = null;
    }
    const soldFromLocalOrders = Math.max(
      0,
      toNumberOrZero(soldFallbackMap.get(productId) || 0),
    );
    const soldFromLive = Math.max(0, toNumberOrZero(liveExportData?.sold));
    const productSold = Math.max(
      0,
      toNumberOrZero(product?.sold),
      soldFromLocalOrders,
      soldFromLive,
    );
    const productRatingAverage = toFiniteNumberOrNull(product?.ratingStar);
    const productRatingCount = Math.max(0, toNumberOrZero(product?.ratingCount));
    const shippingSnapshot = buildShippingSnapshot(
      product?.logistics ?? liveExportData?.logisticInfo ?? null,
    );
    const shippingKinds =
      Array.isArray(liveExportData?.shippingKinds) && liveExportData.shippingKinds.length
        ? liveExportData.shippingKinds
        : shippingSnapshot.shippingKinds;
    const shippingMode = liveExportData?.shippingMode || shippingSnapshot.shippingMode || null;
    const logisticsAtiva = resolveLogisticsExportLabel({ shippingKinds, shippingMode });
    const packagingMetrics = resolvePackagingMetricsForExport(product);
    const spxWeightCubageValidation = buildSpxWeightCubageValidationLabel(
      packagingMetrics,
    );
    const packageVolumesFromDescription = extractPackageVolumesFromDescription(
      product?.description,
    );
    const models = Array.isArray(product?.models) ? product.models : [];

    if (models.length > 0) {
      for (const model of models) {
        const modelName = String(model?.name || "").trim();
        const modelSku = String(model?.sku || "").trim();
        const modelStatus = String(model?.status || "").trim() || productStatus;
        const modelStock = Number(model?.stock);
        const modelId = String(model?.modelId || model?.model_id || "").trim();
        const modelLiveData =
          modelId && liveExportData?.modelPriceByModelId instanceof Map
            ? liveExportData.modelPriceByModelId.get(modelId) || null
            : null;
        const modelBasePriceLocal = resolveProductPriceForExport(product, model);
        const modelPromotionPriceLocal = resolvePromotionPriceForExport(product, model);
        let modelBasePrice =
          toFiniteNumberOrNull(modelLiveData?.basePrice) ?? modelBasePriceLocal;
        const modelPromotionPrice =
          toFiniteNumberOrNull(modelLiveData?.promoPrice) ?? modelPromotionPriceLocal;
        const normalizedModelPromotionPrice =
          modelPromotionPrice != null &&
          (modelBasePrice == null || modelPromotionPrice <= modelBasePrice)
            ? modelPromotionPrice
            : null;
        const modelSellingPrice =
          normalizedModelPromotionPrice != null
            ? normalizedModelPromotionPrice
            : modelBasePrice;
        if (
          normalizedModelPromotionPrice != null &&
          modelBasePrice != null &&
          Number(modelBasePrice) === Number(modelSellingPrice)
        ) {
          modelBasePrice = null;
        }
        const modelSoldFromLocal = Math.max(0, toNumberOrZero(model?.sold));
        const modelSoldFromLive = Math.max(0, toNumberOrZero(modelLiveData?.sold));
        const modelSold = Math.max(
          modelSoldFromLocal,
          modelSoldFromLive,
          productSold,
        );

        rows.push({
          sku: modelSku || productSku || "",
          nome: modelName ? `${productName} - ${modelName}` : productName,
          id: productId,
          preco_base_sem_promocao: modelBasePrice,
          preco_venda_promocao: modelSellingPrice,
          preco: modelSellingPrice,
          estoque: Number.isFinite(modelStock) ? modelStock : fallbackStock,
          media_avaliacoes: productRatingAverage,
          qtd_avaliacoes: productRatingCount,
          qtd_vendas: modelSold,
          logistica_ativa: logisticsAtiva,
          logistica_modo: shippingMode || "",
          embalagem_peso_kg: packagingMetrics.packageWeight,
          embalagem_comprimento_cm: packagingMetrics.packageLength,
          embalagem_largura_cm: packagingMetrics.packageWidth,
          embalagem_altura_cm: packagingMetrics.packageHeight,
          volume_embalagem_cm3: packagingMetrics.volumeCm3,
          peso_cubico_kg: packagingMetrics.cubicWeight,
          peso_faturavel_kg: packagingMetrics.chargeableWeight,
          validacao_spx_peso_cubagem: spxWeightCubageValidation,
          caixas_volumes_descricao: packageVolumesFromDescription.summary,
          qtd_caixas_volumes_descricao: packageVolumesFromDescription.boxesCount,
          status_produto: productStatus,
          status_variacao: modelStatus,
          promocao_bloqueada: productPromotionLock.isBlockedNow ? "Sim" : "Nao",
          bloqueio_ate: productPromotionLock.lockUntil || "",
          tempo_restante_bloqueio: productPromotionLock.isBlockedNow
            ? productPromotionLock.remainingLabel
            : "Liberado",
        });
      }
      continue;
    }

    rows.push({
      sku: productSku || "",
      nome: productName,
      id: productId,
      preco_base_sem_promocao: productBasePrice,
      preco_venda_promocao: productSellingPrice,
      preco: productSellingPrice,
      estoque: fallbackStock,
      media_avaliacoes: productRatingAverage,
      qtd_avaliacoes: productRatingCount,
      qtd_vendas: productSold,
      logistica_ativa: logisticsAtiva,
      logistica_modo: shippingMode || "",
      embalagem_peso_kg: packagingMetrics.packageWeight,
      embalagem_comprimento_cm: packagingMetrics.packageLength,
      embalagem_largura_cm: packagingMetrics.packageWidth,
      embalagem_altura_cm: packagingMetrics.packageHeight,
      volume_embalagem_cm3: packagingMetrics.volumeCm3,
      peso_cubico_kg: packagingMetrics.cubicWeight,
      peso_faturavel_kg: packagingMetrics.chargeableWeight,
      validacao_spx_peso_cubagem: spxWeightCubageValidation,
      caixas_volumes_descricao: packageVolumesFromDescription.summary,
      qtd_caixas_volumes_descricao: packageVolumesFromDescription.boxesCount,
      status_produto: productStatus,
      status_variacao: "",
      promocao_bloqueada: productPromotionLock.isBlockedNow ? "Sim" : "Nao",
      bloqueio_ate: productPromotionLock.lockUntil || "",
      tempo_restante_bloqueio: productPromotionLock.isBlockedNow
        ? productPromotionLock.remainingLabel
        : "Liberado",
    });
  }

  res.json({
    items: rows,
    meta: {
      totalProducts: products.length,
      totalRows: rows.length,
      filters: {
        includeInactive,
        statuses: statusFilters,
        skus: skuFilters,
      },
    },
  });
}

async function listDeadlineControlCandidates(shopId, { q = "", skus = [] } = {}) {
  const total = await countProductsForManagement(shopId, {
    q,
    includeInactive: false,
    statuses: [],
    skuList: skus,
  });

  if (!Number.isFinite(total) || total <= 0) return [];

  const pageSize = 500;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = [];

  for (let page = 0; page < pages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const chunkRows = await listProductsForManagement(shopId, {
      q,
      includeInactive: false,
      statuses: [],
      skuList: skus,
      sortBy: "updatedAt",
      sortDir: "desc",
      skip: page * pageSize,
      take: pageSize,
    });
    rows.push(...(Array.isArray(chunkRows) ? chunkRows : []));
  }

  return rows;
}

function filterDeadlineCandidatesByShippingMode(products, shippingFilter) {
  if (shippingFilter === "all") return products;

  return (Array.isArray(products) ? products : []).filter((product) => {
    const analysis = analyzeLogistics(product?.logistics);
    if (shippingFilter === "spx") return Boolean(analysis?.spxEnabled);
    if (shippingFilter === "seller") {
      return Array.isArray(analysis?.enabledChannels)
        ? analysis.enabledChannels.some((channel) => channel?.kind === "intelipost")
        : false;
    }
    return true;
  });
}

async function resolveDeadlineTargets(shopId, payload = {}) {
  const selectAllActive = Boolean(payload?.selectAllActive);
  const shippingFilter = normalizeDeadlineShippingFilter(payload?.shippingFilter);
  const nameQuery = String(payload?.nameQuery || payload?.q || "").trim();

  const itemIds = parseItemIdsInput(payload?.itemIds || payload?.itemIdList || payload?.ids);
  const skuList = parseSkusInput(payload?.skuList || payload?.skus || payload?.itemSkuList);
  const mixedTokens = parseListInput(payload?.idSkuList || payload?.idSkuTokens || payload?.idSku);
  const mixedIds = mixedTokens.filter((value) => /^\d+$/.test(value));
  const mixedSkus = mixedTokens
    .filter((value) => !/^\d+$/.test(value))
    .map((value) => value.toUpperCase());

  const finalItemIdSet = new Set([...itemIds, ...mixedIds].map((value) => String(value)));
  const finalSkuSet = new Set([...skuList, ...mixedSkus].map((value) => String(value).toUpperCase()));
  const hasDirectFilters =
    finalItemIdSet.size > 0 || finalSkuSet.size > 0 || Boolean(nameQuery);

  if (!selectAllActive && !hasDirectFilters) {
    return {
      targets: [],
      summary: {
        requestedItemIds: [],
        requestedSkus: [],
        nameQuery,
        shippingFilter,
        selectAllActive,
      },
    };
  }

  let candidates = [];
  if (selectAllActive || nameQuery || finalSkuSet.size > 0) {
    candidates = await listDeadlineControlCandidates(shopId, {
      q: nameQuery,
      skus: Array.from(finalSkuSet),
    });
  }

  if (finalItemIdSet.size > 0) {
    const byIds = await listProductsByShopAndItemIdsForManagement(
      shopId,
      Array.from(finalItemIdSet),
    );
    const map = new Map(
      (Array.isArray(candidates) ? candidates : [])
        .map((row) => [String(row?.itemId || ""), row])
        .filter(([key]) => /^\d+$/.test(key)),
    );
    for (const row of Array.isArray(byIds) ? byIds : []) {
      const key = String(row?.itemId || "");
      if (!/^\d+$/.test(key)) continue;
      if (!map.has(key)) map.set(key, row);
    }
    candidates = Array.from(map.values());
  }

  if (!selectAllActive && finalItemIdSet.size > 0) {
    candidates = candidates.filter((row) => finalItemIdSet.has(String(row?.itemId || "")));
  }

  candidates = filterDeadlineCandidatesByShippingMode(candidates, shippingFilter);

  const byItemId = new Map();
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const itemId = String(row?.itemId || "").trim();
    if (!/^\d+$/.test(itemId)) continue;
    if (byItemId.has(itemId)) continue;
    byItemId.set(itemId, {
      itemId,
      title: row?.title || null,
      status: row?.status || null,
      itemSku: row?.itemSku || null,
      daysToShip: toFiniteNumberOrNull(row?.daysToShip),
      logistics: row?.logistics || null,
    });
  }
  const targets = Array.from(byItemId.values());

  return {
    targets,
    summary: {
      requestedItemIds: Array.from(finalItemIdSet),
      requestedSkus: Array.from(finalSkuSet),
      nameQuery,
      shippingFilter,
      selectAllActive,
    },
  };
}

async function deadlineControlPreview(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const resolved = await resolveDeadlineTargets(shop.id, payload);
  const targets = Array.isArray(resolved?.targets) ? resolved.targets : [];
  const limitedTargets = targets.slice(0, 500);

  return res.json({
    ok: true,
    total: targets.length,
    shown: limitedTargets.length,
    targets: limitedTargets.map((target) => {
      const analysis = analyzeLogistics(target?.logistics);
      return {
        itemId: target.itemId,
        title: target.title,
        status: target.status,
        itemSku: target.itemSku,
        daysToShip: target.daysToShip,
        shippingMode: analysis?.shippingMode || null,
      };
    }),
    summary: resolved?.summary || {},
  });
}

function normalizeDeadlineMappings(rawMappings) {
  const byItemId = new Map();
  const invalid = [];

  for (const entry of Array.isArray(rawMappings) ? rawMappings : []) {
    const itemId = String(entry?.itemId ?? entry?.item_id ?? "").trim();
    const daysToShip = toFiniteNumberOrNull(
      entry?.daysToShip ?? entry?.prazo ?? entry?.days,
    );

    if (!/^\\d+$/.test(itemId) || !Number.isInteger(daysToShip) || daysToShip < 3 || daysToShip > 15) {
      invalid.push({ itemId: itemId || null, daysToShip });
      continue;
    }
    byItemId.set(itemId, daysToShip);
  }

  return { byItemId, invalid };
}

async function deadlineControlApply(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const action = String(payload?.action || payload?.mode || "").trim().toLowerCase();
  const enablePreOrder = action === "enable";
  const disablePreOrder = action === "disable";
  const deadlineMappings = normalizeDeadlineMappings(payload?.deadlineMappings);

  if (!enablePreOrder && !disablePreOrder) {
    return res.status(400).json({
      error: "deadline_action_invalid",
      message: "Ação inválida. Use enable ou disable.",
    });
  }

  const daysToShip = toFiniteNumberOrNull(payload?.daysToShip);
  if (deadlineMappings.invalid.length) {
    return res.status(400).json({
      error: "deadline_mapping_invalid",
      message: "Cada prazo da planilha deve ser um inteiro entre 3 e 15 dias.",
      invalidRows: deadlineMappings.invalid,
    });
  }
  if (enablePreOrder) {
    if (
      deadlineMappings.byItemId.size === 0 &&
      (!Number.isInteger(daysToShip) || daysToShip < 3 || daysToShip > 15)
    ) {
      return res.status(400).json({
        error: "deadline_days_invalid",
        message: "Prazo sob encomenda deve estar entre 3 e 15 dias.",
      });
    }
  }

  const concurrencyRaw = Number(payload?.concurrency);
  const concurrency = Number.isFinite(concurrencyRaw)
    ? Math.min(12, Math.max(1, Math.floor(concurrencyRaw)))
    : 4;

  const targetPayload = deadlineMappings.byItemId.size
    ? {
        ...payload,
        itemIds: Array.from(deadlineMappings.byItemId.keys()).join(","),
        skuList: "",
        idSkuList: "",
        nameQuery: "",
        selectAllActive: false,
        shippingFilter: "all",
      }
    : payload;
  const resolved = await resolveDeadlineTargets(shop.id, targetPayload);
  const targets = Array.isArray(resolved?.targets) ? resolved.targets : [];

  if (!targets.length) {
    return res.status(400).json({
      error: "deadline_targets_empty",
      message:
        "Nenhum produto encontrado com os filtros informados para controle de prazo.",
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      logs: [],
    });
  }

  const shopShopeeId = String(shop.shopId);
  const logs = await mapWithConcurrency(targets, concurrency, async (target) => {
    const itemIdNum = Number(target?.itemId);
    if (!Number.isFinite(itemIdNum) || itemIdNum <= 0) {
      return {
        ok: false,
        itemId: target?.itemId || null,
        title: target?.title || null,
        code: "item_id_invalid",
        message: "Item ID inválido para atualização de prazo.",
      };
    }

    const fallbackDaysToShip = Math.min(
      15,
      Math.max(
        3,
        Number.isInteger(Number(target?.daysToShip))
          ? Number(target.daysToShip)
          : 3,
      ),
    );

    const targetDaysToShip = enablePreOrder
      ? deadlineMappings.byItemId.get(String(target.itemId)) ?? Number(daysToShip)
      : null;
    const preOrderPayload = enablePreOrder
      ? {
          is_pre_order: true,
          days_to_ship: targetDaysToShip,
        }
      : {
          is_pre_order: false,
          days_to_ship: fallbackDaysToShip,
        };

    try {
      await ShopeeProductWriteService.updateItem({
        shopId: shopShopeeId,
        body: {
          item_id: itemIdNum,
          pre_order: preOrderPayload,
        },
      });

      await updateProductByShopAndItemId(shop.id, String(target.itemId), {
        daysToShip: enablePreOrder ? targetDaysToShip : null,
      });

      return {
        ok: true,
        itemId: target.itemId,
        title: target.title || null,
        code: "updated",
        message: enablePreOrder
          ? `Prazo sob encomenda atualizado para ${targetDaysToShip} dias.`
          : "Prazo sob encomenda desabilitado com sucesso.",
      };
    } catch (error) {
      return {
        ok: false,
        itemId: target.itemId,
        title: target.title || null,
        code: String(error?.shopee?.error || "update_failed"),
        message: mapDeadlineErrorMessage(error),
      };
    }
  });

  const success = logs.filter((row) => row?.ok).length;
  const failed = logs.filter((row) => !row?.ok).length;

  return res.json({
    ok: failed === 0,
    total: targets.length,
    processed: logs.length,
    success,
    failed,
    action: enablePreOrder ? "enable" : "disable",
    daysToShip: enablePreOrder && deadlineMappings.byItemId.size === 0 ? Number(daysToShip) : null,
    mappedDeadlines: deadlineMappings.byItemId.size,
    logs,
    summary: resolved?.summary || {},
  });
}

async function detail(req, res) {
  const { itemId } = req.params;
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const product = await findProductDetailByShopAndItemId(shop.id, itemId);
  if (!product) return res.status(404).json({ error: "product_not_found" });
  const lockMap = await listActivePriceLocksSafe(shop.id, [product?.itemId], new Date());
  const lockEntry = lockMap.get(String(product?.itemId || ""));
  const promotionLock = buildPromotionLockPayload(lockEntry, new Date());

  res.json({
    product: {
      ...product,
      ...buildShippingSnapshot(product.logistics),
      promotionLock,
    },
  });
}

async function updateItem(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const result = await ShopeeProductWriteService.updateItem({
      shopId: String(shop.shopId),
      body: { ...req.body, item_id: Number(itemId) },
    });

    const product = await findProductIdByShopAndItemId(shop.id, itemId);
    if (product) {
      await persistImagesFromUpdateItemResponse(product.id, result);
    }

    return res.json({ status: "ok", result });
  } catch (err) {
    return next(err);
  }
}

async function updatePrice(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const result = await ShopeeProductWriteService.updatePrice({
      shopId: String(shop.shopId),
      body: { ...req.body, item_id: Number(itemId) },
    });

    return res.json({ status: "ok", result });
  } catch (err) {
    return next(err);
  }
}

async function updateStock(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const result = await ShopeeProductWriteService.updateStock({
      shopId: String(shop.shopId),
      body: { ...req.body, item_id: Number(itemId) },
    });

    return res.json({ status: "ok", result });
  } catch (err) {
    return next(err);
  }
}

async function uploadAndApplyImages(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const files = req.files || [];
    if (files.length < 1) {
      return res.status(400).json({ error: "no_images_uploaded" });
    }
    if (files.length > 3) {
      return res.status(400).json({ error: "max_3_images" });
    }

    const business = Number(req.body.business);
    const scene = Number(req.body.scene);
    if (!Number.isFinite(business) || !Number.isFinite(scene)) {
      return res.status(400).json({ error: "business_scene_required" });
    }

    const imageList = await ShopeeMediaService.uploadImage({
      files,
      business,
      scene,
    });
    const imageIds = imageList.map((entry) => entry.image_id).filter(Boolean);

    if (!imageIds.length) {
      return res.status(502).json({ error: "upload_failed_no_image_ids" });
    }

    const updated = await ShopeeProductWriteService.updateItem({
      shopId: String(shop.shopId),
      body: {
        item_id: Number(itemId),
        image: { image_id_list: imageIds },
      },
    });

    const product = await findProductIdByShopAndItemId(shop.id, itemId);
    if (product) {
      await persistImagesFromUpdateItemResponse(product.id, updated);
    }

    return res.json({ status: "ok", uploaded: imageList, updated });
  } catch (err) {
    return next(err);
  }
}

async function addImages(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const files = req.files || [];
    if (files.length < 1) {
      return res.status(400).json({ error: "no_images_uploaded" });
    }
    if (files.length > 3) {
      return res.status(400).json({ error: "max_3_images" });
    }

    const business = Number(req.body.business);
    const scene = Number(req.body.scene);
    if (!Number.isFinite(business) || !Number.isFinite(scene)) {
      return res.status(400).json({ error: "business_scene_required" });
    }

    const product = await findProductDetailByShopAndItemId(shop.id, itemId);
    if (!product) return res.status(404).json({ error: "product_not_found" });

    const existingIds = (product.images || []).map((image) => image.imageId).filter(Boolean);
    if (!existingIds.length) {
      return res.status(409).json({
        error: "no_existing_image_ids",
        message:
          "Este produto nao tem imageId salvo no banco. Faca um update de imagens (rota /images) ao menos uma vez para o sistema passar a armazenar image_id_list e habilitar add/remove sem perder as imagens atuais.",
      });
    }

    const uploaded = await ShopeeMediaService.uploadImage({
      files,
      business,
      scene,
    });
    const newIds = uploaded.map((entry) => entry.image_id).filter(Boolean);
    const finalIds = dedupPreserveOrder([...existingIds, ...newIds]);

    if (!finalIds.length) {
      return res.status(502).json({ error: "final_image_ids_empty" });
    }

    const updated = await ShopeeProductWriteService.updateItem({
      shopId: String(shop.shopId),
      body: {
        item_id: Number(itemId),
        image: { image_id_list: finalIds },
      },
    });

    await persistImagesFromUpdateItemResponse(product.id, updated);
    return res.json({ status: "ok", uploaded, updated });
  } catch (err) {
    return next(err);
  }
}

async function removeImages(req, res, next) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const removeImageIds = Array.isArray(req.body?.removeImageIds)
      ? req.body.removeImageIds
      : [];
    const removeSet = new Set(removeImageIds.map((value) => String(value)));

    if (!removeSet.size) {
      return res.status(400).json({ error: "removeImageIds_required" });
    }

    const product = await findProductDetailByShopAndItemId(shop.id, itemId);
    if (!product) return res.status(404).json({ error: "product_not_found" });

    const existingIds = (product.images || []).map((image) => image.imageId).filter(Boolean);
    if (!existingIds.length) {
      return res.status(409).json({
        error: "no_existing_image_ids",
        message:
          "Este produto nao tem imageId salvo no banco. Faca um update de imagens (rota /images) ao menos uma vez para salvar image_id_list.",
      });
    }

    const finalIds = existingIds.filter((imageId) => !removeSet.has(String(imageId)));
    if (finalIds.length < 1) {
      return res.status(400).json({ error: "cannot_remove_all_images" });
    }

    const updated = await ShopeeProductWriteService.updateItem({
      shopId: String(shop.shopId),
      body: {
        item_id: Number(itemId),
        image: { image_id_list: finalIds },
      },
    });

    await persistImagesFromUpdateItemResponse(product.id, updated);
    return res.json({ status: "ok", updated });
  } catch (err) {
    return next(err);
  }
}

function isYyyyMmDd(v) {
  return /^\d{8}$/.test(String(v ?? "").trim());
}

async function performance(req, res, next) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const periodType = String(req.query.periodType || "").trim();
    const startDate = String(req.query.startDate || "").trim();
    const endDate = String(req.query.endDate || "").trim();

    if (!periodType) return res.status(400).json({ error: "periodType_required" });
    if (!isYyyyMmDd(startDate)) return res.status(400).json({ error: "startDate_invalid" });
    if (!isYyyyMmDd(endDate)) return res.status(400).json({ error: "endDate_invalid" });

    const pageNo = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(20, Math.max(1, Number(req.query.pageSize || 20)));
    const orderType = String(req.query.orderType || "ConfirmedOrder");
    const channel = String(req.query.channel || "AllChannel");
    const itemId = req.query.itemId ? String(req.query.itemId) : null;

    const result = await ShopeeAmsService.getProductPerformance({
      shopId: String(shop.shopId),
      periodType,
      startDate,
      endDate,
      pageNo,
      pageSize,
      orderType,
      channel,
      itemId,
    });

    return res.json({ status: "ok", result });
  } catch (err) {
    return next(err);
  }
}

async function fullDetail(req, res) {
  const { itemId } = req.params;
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const product = await findProductDetailByShopAndItemId(shop.id, itemId);
  if (!product) return res.status(404).json({ error: "product_not_found" });
  const lockMap = await listActivePriceLocksSafe(shop.id, [product?.itemId], new Date());
  const lockEntry = lockMap.get(String(product?.itemId || ""));
  const promotionLock = buildPromotionLockPayload(lockEntry, new Date());
  const variationSales = await listVariationSalesByProductId(shop.id, product.id);
  const variationSalesMap = new Map(
    variationSales
      .filter((row) => row?.modelId != null)
      .map((row) => [String(row.modelId), row]),
  );

  const totalStock = product.hasModel
    ? (product.models || []).reduce((acc, model) => acc + (Number(model.stock) || 0), 0)
    : product.stock ?? null;

  let description = product.description || null;
  try {
    const extra = await ShopeeProductService.getItemExtraInfo({
      shopId: String(shop.shopId),
      itemId,
    });
    description = extra?.response?.description || description;
  } catch (_error) {}

  const models = Array.isArray(product.models)
    ? product.models.map((model) => {
        const key = model?.modelId != null ? String(model.modelId) : "";
        const sales = variationSalesMap.get(key);
        return {
          ...model,
          sku: model?.sku || sales?.modelSku || null,
          sold:
            Number.isFinite(Number(sales?.quantity))
              ? Number(sales.quantity)
              : Number(model?.sold || 0),
          revenueCents: Number(sales?.revenueCents || 0),
        };
      })
    : [];
  const totalSold = Number.isFinite(Number(product?.sold))
    ? Number(product.sold)
    : models.reduce((acc, model) => acc + (Number(model?.sold) || 0), 0);

  const shopIdText = String(shop?.shopId || "").trim();
  const storefrontUrl =
    /^\d+$/.test(shopIdText) && /^\d+$/.test(String(itemId || ""))
      ? `https://shopee.com.br/product/${shopIdText}/${String(itemId)}`
      : null;

  return res.json({
    product: {
      ...product,
      models,
      sold: totalSold,
      totalStock,
      promotionLock,
      ...buildShippingSnapshot(product.logistics),
    },
    extra: {
      description: description || product.description || null,
      attributes: product.attributes || null,
      logistics: extractLogistics(product.logistics),
      ...buildShippingSnapshot(product.logistics),
      dimension: product.dimension || null,
      weight: product.weight ?? null,
      daysToShip: product.daysToShip ?? null,
      itemUrl: storefrontUrl,
      itemEditUrl: `https://seller.shopee.com.br/portal/product/${encodeURIComponent(
        String(itemId),
      )}`,
    },
  });
}

async function curvesAbc(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;
    const abcMode = resolveAbcMetricMode(req.query?.mode || req.query?.abcMode);

    const currentRange = buildRangeFromQuery(req, 30);
    const previousRange = buildPreviousRange(currentRange.start, currentRange.end);

    const [currentRows, previousRows] = await Promise.all([
      listProductSalesSnapshotByRange(
        shop.id,
        currentRange.start,
        currentRange.end,
        { includeInactive: true },
      ),
      listProductSalesSnapshotByRange(
        shop.id,
        previousRange.start,
        previousRange.end,
        { includeInactive: true },
      ),
    ]);

    const previousMap = mapMetricsByProductId(previousRows);
    const soldRows = currentRows
      .filter(
        (row) =>
          toNumberOrZero(row.revenueCents) > 0 || toNumberOrZero(row.quantity) > 0,
      )
      .map((row) => {
        const previous = previousMap.get(Number(row.id)) || {};
        return {
          ...row,
          sold: toNumberOrZero(row.quantity),
          revenue: toNumberOrZero(row.revenueCents) / 100,
          growthRevenuePct: pctGrowth(
            toNumberOrZero(row.revenueCents),
            toNumberOrZero(previous.revenueCents),
          ),
          growthOrdersPct: pctGrowth(
            toNumberOrZero(row.orders),
            toNumberOrZero(previous.orders),
          ),
          growthQuantityPct: pctGrowth(
            toNumberOrZero(row.quantity),
            toNumberOrZero(previous.quantity),
          ),
        };
      })
      .sort(
        (a, b) =>
          (abcMode === "orders"
            ? toNumberOrZero(b.orders) - toNumberOrZero(a.orders)
            : toNumberOrZero(b.revenueCents) - toNumberOrZero(a.revenueCents)) ||
          toNumberOrZero(b.quantity) - toNumberOrZero(a.quantity) ||
          toNumberOrZero(b.revenueCents) - toNumberOrZero(a.revenueCents),
      );

    const {
      totalRevenueCents,
      totalMetric,
      metricField,
      metricLabel,
      metricLabelPlural,
      curves,
    } = buildCurvesFromSalesRows(soldRows, abcMode);

    res.json({
      meta: {
        dateFrom: currentRange.start.toISOString().slice(0, 10),
        dateTo: currentRange.end.toISOString().slice(0, 10),
        previousDateFrom: previousRange.start.toISOString().slice(0, 10),
        previousDateTo: previousRange.end.toISOString().slice(0, 10),
        periodLabel: `${normalizeDateLabel(currentRange.start)} ate ${normalizeDateLabel(currentRange.end)}`,
        abcMode,
        metricField,
        metricLabel,
        metricLabelPlural,
        totalMetric,
        totalRevenue: totalRevenueCents / 100,
        totalOrders: soldRows.reduce(
          (total, row) => total + toNumberOrZero(row.orders),
          0,
        ),
        totalIdsWithSales: soldRows.length,
      },
      curves,
      items: soldRows,
    });
  } catch (error) {
    console.error("products.curvesAbc failed:", error);
    res.status(500).json({
      error: "curves_abc_failed",
      message: String(error?.message || error),
    });
  }
}

async function relaunch(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const allowedDays = new Set([30, 60, 90, 120, 150, 180, 365]);
    const requestedDays = Number(req.query?.daysWithoutSales || 90);
    const daysWithoutSales = allowedDays.has(requestedDays) ? requestedDays : 90;
    const sinceCreation =
      String(req.query?.sinceCreation || "").toLowerCase() === "true";
    const includeRatedIdsRequested =
      String(
        req.query?.includeRatedIds ?? req.query?.includeCommentedRatings ?? "",
      ).toLowerCase() === "true";
    // Regra: sem vendas desde a criacao deve listar apenas itens sem avaliacao real.
    const includeRatedIds = sinceCreation ? false : includeRatedIdsRequested;
    const since = sinceCreation
      ? null
      : new Date(Date.now() - daysWithoutSales * 24 * 60 * 60 * 1000);
    const normalizeRelaunchProduct = (product) => ({
      ...product,
      sku: product.itemSku || null,
      totalStock: resolveProductTotalStock(product),
    });

    const productsNoSalesRaw = await listProductsWithoutSalesSince(shop.id, since);
    const productsNoSalesFiltered = productsNoSalesRaw.filter((product) => {
      if (includeRatedIds) return true;
      return toNumberOrZero(product?.ratingCount) <= 0;
    });
    const productsNoSalesActive = productsNoSalesFiltered.filter((product) =>
      isActiveProductStatus(product?.status),
    );
    const productsNoSalesPaused = productsNoSalesFiltered.filter((product) =>
      isPausedProductStatus(product?.status),
    );
    const productsNoSalesOutOfStock = productsNoSalesActive.filter(
      (product) => resolveProductTotalStock(product) <= 0,
    );

    res.json({
      meta: {
        mode: sinceCreation ? "since_creation" : `${daysWithoutSales}_days`,
        daysWithoutSales,
        sinceCreation,
        includeRatedIds,
        includeRatedIdsRequested,
      },
      summary: {
        totalNoSalesActive: productsNoSalesActive.length,
        totalNoSalesPaused: productsNoSalesPaused.length,
        totalNoSalesOutOfStock: productsNoSalesOutOfStock.length,
      },
      sections: {
        noSales: {
          label: "Sem vendas",
          description: sinceCreation
            ? includeRatedIds
              ? "Produtos sem vendas desde a criacao, com e sem avaliacao real."
              : "Produtos sem vendas desde a criacao e sem avaliacao real."
            : includeRatedIds
              ? `Produtos com 0 vendas nos ultimos ${daysWithoutSales} dias, com e sem avaliacao real.`
              : `Produtos com 0 vendas nos ultimos ${daysWithoutSales} dias e sem avaliacao real.`,
          count: productsNoSalesActive.length,
          products: productsNoSalesActive.map(normalizeRelaunchProduct),
        },
      },
    });
  } catch (error) {
    console.error("products.relaunch failed:", error);
    res.status(500).json({
      error: "relaunch_failed",
      message: String(error?.message || error),
    });
  }
}

async function salesShare(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;
    const summaryOnly =
      String(req.query?.summaryOnly || "").toLowerCase() === "true";

    const currentRange = buildRangeFromQuery(req, 30);
    const previousRange = buildPreviousRange(currentRange.start, currentRange.end);

    const [currentRowsRaw, previousRowsRaw] = await Promise.all([
      listProductSalesSnapshotByRange(
        shop.id,
        currentRange.start,
        currentRange.end,
      ),
      listProductSalesSnapshotByRange(
        shop.id,
        previousRange.start,
        previousRange.end,
      ),
    ]);
    const currentRows = currentRowsRaw.filter((row) =>
      isActiveProductStatus(row?.status),
    );
    const previousRows = previousRowsRaw.filter((row) =>
      isActiveProductStatus(row?.status),
    );
    const currentPausedRows = currentRowsRaw.filter((row) =>
      isPausedProductStatus(row?.status),
    );
    const currentOutOfStockActiveRows = currentRows.filter(
      (row) => resolveProductTotalStock(row) <= 0,
    );

    const totalRevenueCents = currentRows.reduce(
      (total, row) => total + toNumberOrZero(row.revenueCents),
      0,
    );
    const withSalesBase = currentRows.filter(
      (row) => toNumberOrZero(row.revenueCents) > 0 || toNumberOrZero(row.quantity) > 0,
    );
    const withoutSalesBase = currentRows.filter(
      (row) => toNumberOrZero(row.revenueCents) <= 0 && toNumberOrZero(row.quantity) <= 0,
    );
    const previousWithSalesCount = previousRows.filter(
      (row) => toNumberOrZero(row.revenueCents) > 0 || toNumberOrZero(row.quantity) > 0,
    ).length;
    const previousShareIdsWithSalesPct =
      previousRows.length > 0
        ? Number(((previousWithSalesCount / previousRows.length) * 100).toFixed(2))
        : 0;
    const currentShareIdsWithSalesPct =
      currentRows.length > 0
        ? Number(((withSalesBase.length / currentRows.length) * 100).toFixed(2))
        : 0;
    const shareIdsWithSalesMoMPct = Number(
      (currentShareIdsWithSalesPct - previousShareIdsWithSalesPct).toFixed(2),
    );
    const topRevenueSharePct =
      totalRevenueCents > 0
        ? Number(
            (
              withSalesBase
                .slice(0, 10)
                .reduce((total, row) => total + toNumberOrZero(row.revenueCents), 0) /
              totalRevenueCents *
              100
            ).toFixed(2),
          )
        : 0;

    if (summaryOnly) {
      return res.json({
        meta: {
          dateFrom: currentRange.start.toISOString().slice(0, 10),
          dateTo: currentRange.end.toISOString().slice(0, 10),
          periodLabel: `${normalizeDateLabel(currentRange.start)} ate ${normalizeDateLabel(currentRange.end)}`,
        },
        summary: {
          totalIds: currentRows.length,
          totalActiveIds: currentRows.length,
          totalPausedIds: currentPausedRows.length,
          totalOutOfStockActiveIds: currentOutOfStockActiveRows.length,
          idsWithSales: withSalesBase.length,
          idsWithoutSales: withoutSalesBase.length,
          shareIdsWithSalesPct: currentShareIdsWithSalesPct,
          shareIdsWithoutSalesPct:
            currentRows.length > 0
              ? Number(((withoutSalesBase.length / currentRows.length) * 100).toFixed(2))
              : 0,
          previousShareIdsWithSalesPct,
          shareIdsWithSalesMoMPct,
          revenue: totalRevenueCents / 100,
          averageRevenuePerSoldId:
            withSalesBase.length > 0
              ? totalRevenueCents / 100 / withSalesBase.length
              : 0,
          topRevenueSharePct,
        },
      });
    }

    const previousMap = mapMetricsByProductId(previousRows);
    const items = currentRows.map((row) => {
      const previous = previousMap.get(Number(row.id)) || {};
      const revenueCents = toNumberOrZero(row.revenueCents);
      return {
        ...row,
        totalStock: resolveProductTotalStock(row),
        stock: resolveProductTotalStock(row),
        sold: toNumberOrZero(row.quantity),
        revenue: revenueCents / 100,
        shareRevenuePct:
          totalRevenueCents > 0
            ? Number(((revenueCents / totalRevenueCents) * 100).toFixed(2))
            : 0,
        growthRevenuePct: pctGrowth(
          revenueCents,
          toNumberOrZero(previous.revenueCents),
        ),
        growthOrdersPct: pctGrowth(
          toNumberOrZero(row.orders),
          toNumberOrZero(previous.orders),
        ),
      };
    });

    const withSalesItemsBase = items.filter(
      (row) => row.revenueCents > 0 || toNumberOrZero(row.quantity) > 0,
    );
    const withoutSalesItemsBase = items.filter(
      (row) => row.revenueCents <= 0 && toNumberOrZero(row.quantity) <= 0,
    );
    const [withSales, withoutSales] = await Promise.all([
      enrichRowsWithLiveCategoryIds(shop, withSalesItemsBase),
      enrichRowsWithLiveCategoryIds(shop, withoutSalesItemsBase),
    ]);

    res.json({
      meta: {
        dateFrom: currentRange.start.toISOString().slice(0, 10),
        dateTo: currentRange.end.toISOString().slice(0, 10),
        periodLabel: `${normalizeDateLabel(currentRange.start)} ate ${normalizeDateLabel(currentRange.end)}`,
      },
      summary: {
        totalIds: items.length,
        totalActiveIds: items.length,
        totalPausedIds: currentPausedRows.length,
        totalOutOfStockActiveIds: currentOutOfStockActiveRows.length,
        idsWithSales: withSales.length,
        idsWithoutSales: withoutSales.length,
        shareIdsWithSalesPct: currentShareIdsWithSalesPct,
        shareIdsWithoutSalesPct:
          items.length > 0
            ? Number(((withoutSales.length / items.length) * 100).toFixed(2))
            : 0,
        previousShareIdsWithSalesPct,
        shareIdsWithSalesMoMPct,
        revenue: totalRevenueCents / 100,
        averageRevenuePerSoldId:
          withSales.length > 0 ? totalRevenueCents / 100 / withSales.length : 0,
        topRevenueSharePct,
      },
      lists: {
        withSales,
        withoutSales,
      },
    });
  } catch (error) {
    console.error("products.salesShare failed:", error);
    res.status(500).json({
      error: "sales_share_failed",
      message: String(error?.message || error),
    });
  }
}

async function salesControl(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const currentRange = buildRangeFromQuery(req, 30);
    const allowedLimits = new Set([10, 15, 20, 30, 40, 50]);
    const requestedLimit = Number(req.query?.limit || 20);
    const limit = allowedLimits.has(requestedLimit) ? requestedLimit : 20;
    const filterModeRaw = String(req.query?.filterMode || "low_conversion")
      .trim()
      .toLowerCase();
    const onlyNoSales = parseBooleanFlag(req.query?.onlyNoSales);
    const filterMode = onlyNoSales
      ? "no_sales"
      : filterModeRaw === "all"
        ? "all"
        : filterModeRaw === "no_sales"
          ? "no_sales"
          : "low_conversion";
    const maxConversionPct = Math.max(
      0,
      Math.min(100, Number(req.query?.maxConversionPct ?? 2) || 2),
    );
    const requestedItemIds = dedupPreserveOrder(
      parseCommaSeparatedValues(req.query?.itemId || req.query?.itemIds || req.query?.q)
        .map((value) => String(value || "").trim())
        .filter((value) => onlyDigits(value)),
    );
    const requestedItemIdSet = new Set(requestedItemIds);

    const localRows = await listProductSalesSnapshotByRange(
      shop.id,
      currentRange.start,
      currentRange.end,
    );
    const candidateRows =
      requestedItemIdSet.size > 0
        ? localRows.filter((row) =>
            requestedItemIdSet.has(String(row?.itemId || "").trim()),
          )
        : localRows;
    const localItemIds = dedupPreserveOrder(
      candidateRows
        .map((row) => String(row?.itemId || "").trim())
        .filter((itemId) => onlyDigits(itemId)),
    );
    const organicTraffic = await loadOrganicTrafficMapForSalesControl(
      shop,
      localItemIds,
      currentRange.start,
      currentRange.end,
    );
    const mergedRows = candidateRows
      .filter((row) => onlyDigits(row?.itemId))
      .map((row) => {
        const itemId = String(row.itemId);
        const sold = Math.max(0, toNumberOrZero(row?.quantity));
        const traffic = organicTraffic.trafficMap.get(itemId) || {
          visits: 0,
        };
        const visits = Math.max(0, toNumberOrZero(traffic.visits));
        const conversionPct = visits > 0 ? Number(((sold / visits) * 100).toFixed(2)) : 0;
        return {
          itemId,
          title:
            String(row?.title || "").trim() ||
            `Item ${itemId}`,
          visits,
          sold,
          conversionPct,
          revenue: Number((toNumberOrZero(row?.revenueCents) / 100).toFixed(2)),
        };
      });

    const filteredRows = mergedRows
      .filter((row) => row.visits > 0 || row.sold > 0)
      .filter((row) => {
        if (filterMode === "all") return true;
        if (filterMode === "no_sales") return row.sold <= 0;
        return row.sold <= 0 || row.conversionPct <= maxConversionPct;
      })
      .sort(
        (a, b) =>
          b.visits - a.visits ||
          a.sold - b.sold ||
          a.conversionPct - b.conversionPct,
      );

    const topRows = filteredRows.slice(0, limit);
    const totalVisits = topRows.reduce((sum, row) => sum + toNumberOrZero(row.visits), 0);
    const totalSales = topRows.reduce((sum, row) => sum + toNumberOrZero(row.sold), 0);
    const avgConversionPct =
      topRows.length > 0
        ? Number(
            (
              topRows.reduce((sum, row) => sum + toNumberOrZero(row.conversionPct), 0) /
              topRows.length
            ).toFixed(2),
          )
        : 0;
    const zeroSalesCount = topRows.filter((row) => row.sold <= 0).length;
    const highTrafficLowConversionCount = topRows.filter(
      (row) => row.visits >= 30 && row.conversionPct <= maxConversionPct,
    ).length;

    res.json({
      meta: {
        dateFrom: currentRange.start.toISOString().slice(0, 10),
        dateTo: currentRange.end.toISOString().slice(0, 10),
        periodLabel: `${normalizeDateLabel(currentRange.start)} ate ${normalizeDateLabel(currentRange.end)}`,
        filterMode,
        maxConversionPct,
        limit,
        itemIds: requestedItemIds,
        source: "organic_item_extra_info+local_orders",
        organicTrafficFetched: organicTraffic.fetchedCount,
        organicTrafficCacheHits: organicTraffic.cacheHits,
        organicTrafficHistoricalHits: organicTraffic.historicalHits,
        organicTrafficTrackedToday: organicTraffic.trackedTodayCount,
        organicTrafficPersistedToday: organicTraffic.persistedTodayCount,
        warning: organicTraffic.warning
          ? organicTraffic.warning
          : organicTraffic.truncated
            ? `A consulta de trafego organico foi limitada aos primeiros ${SALES_CONTROL_ORGANIC_FETCH_LIMIT} IDs ativos para proteger desempenho.`
            : null,
      },
      summary: {
        totalRows: filteredRows.length,
        selectedRows: topRows.length,
        totalVisits,
        totalSales,
        avgConversionPct,
        zeroSalesCount,
        highTrafficLowConversionCount,
      },
      insights: [
        {
          tone: zeroSalesCount > 0 ? "warning" : "positive",
          title: "Produtos sem venda",
          message: `${zeroSalesCount} ID(s) com muitas visitas e nenhuma venda no período.`,
        },
        {
          tone: highTrafficLowConversionCount > 0 ? "warning" : "info",
          title: "Baixa conversão em tráfego quente",
          message: `${highTrafficLowConversionCount} ID(s) com visitas relevantes e conversão até ${maxConversionPct.toFixed(
            2,
          )}%.`,
        },
        {
          tone: "info",
          title: "Ação recomendada",
          message:
            "Priorize revisão de capa, título, preço, frete e ficha técnica dos IDs líderes em visita com baixa conversão.",
        },
      ],
      items: topRows,
      paging: {
        requestedLimit: limit,
        fetchedPages: 1,
        totalPages: 1,
      },
    });
  } catch (error) {
    console.error("products.salesControl failed:", error);
    res.status(500).json({
      error: "sales_control_failed",
      message: String(error?.message || error),
    });
  }
}

async function launches(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const summaryOnly =
      String(req.query?.summaryOnly || "").toLowerCase() === "true";
    const recentDays = Math.max(1, Number(req.query?.recentDays || 30));
    const currentRange = buildRangeFromQuery(req, recentDays);
    const previousRange = buildPreviousRange(currentRange.start, currentRange.end);

    const [currentRows, previousRows] = await Promise.all([
      listProductSalesSnapshotByRange(
        shop.id,
        currentRange.start,
        currentRange.end,
      ),
      listProductSalesSnapshotByRange(
        shop.id,
        previousRange.start,
        previousRange.end,
      ),
    ]);

    const isWithinRange = (rawDate, range) => {
      if (!rawDate) return false;
      const date = new Date(rawDate);
      if (Number.isNaN(date.getTime())) return false;
      return date >= range.start && date <= range.end;
    };

    const totalRevenueCentsCurrent = currentRows.reduce(
      (total, row) => total + toNumberOrZero(row.revenueCents),
      0,
    );
    const totalRevenueCentsPrevious = previousRows.reduce(
      (total, row) => total + toNumberOrZero(row.revenueCents),
      0,
    );

    const previousMap = mapMetricsByProductId(previousRows);
    const launches = currentRows
      .filter((row) => {
        const createdAt = getProductLaunchDate(row);
        return isWithinRange(createdAt, currentRange);
      })
      .map((row) => {
        const previous = previousMap.get(Number(row.id)) || {};
        const quality = buildLaunchQuality(row);
        const revenueCents = toNumberOrZero(row.revenueCents);
        const growthRevenuePct = pctGrowth(
          revenueCents,
          toNumberOrZero(previous.revenueCents),
        );
        return {
          ...row,
          launchDate: getProductLaunchDate(row),
          revenue: revenueCents / 100,
          sold: toNumberOrZero(row.quantity),
          growthRevenuePct,
          growthOrdersPct: pctGrowth(
            toNumberOrZero(row.orders),
            toNumberOrZero(previous.orders),
          ),
          launchQuality: quality,
          isGrowing:
            growthRevenuePct != null
              ? growthRevenuePct > 0
              : revenueCents > 0 || toNumberOrZero(row.quantity) > 0,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.launchDate || 0).getTime() -
            new Date(a.launchDate || 0).getTime() ||
          toNumberOrZero(b.revenueCents) - toNumberOrZero(a.revenueCents),
      );

    const previousLaunches = previousRows.filter((row) => {
      const createdAt = getProductLaunchDate(row);
      return isWithinRange(createdAt, previousRange);
    });

    const totalRevenueCents = launches.reduce(
      (total, row) => total + toNumberOrZero(row.revenueCents),
      0,
    );
    const previousLaunchesRevenueCents = previousLaunches.reduce(
      (total, row) => total + toNumberOrZero(row.revenueCents),
      0,
    );
    const launchRevenueSharePct =
      totalRevenueCentsCurrent > 0
        ? Number(((totalRevenueCents / totalRevenueCentsCurrent) * 100).toFixed(2))
        : 0;
    const previousLaunchRevenueSharePct =
      totalRevenueCentsPrevious > 0
        ? Number(
            (
              (previousLaunchesRevenueCents / totalRevenueCentsPrevious) *
              100
            ).toFixed(2),
          )
        : 0;
    const launchRevenueShareMoMPct = Number(
      (launchRevenueSharePct - previousLaunchRevenueSharePct).toFixed(2),
    );
    const launchesCountMoMPct = pctGrowth(
      launches.length,
      previousLaunches.length,
    );

    const growingCount = launches.filter((row) => row.isGrowing).length;
    const weakCount = launches.filter(
      (row) =>
        !row.isGrowing &&
        (toNumberOrZero(row.revenueCents) <= 0 || row.launchQuality?.score < 70),
    ).length;
    const averageQuality = launches.length
      ? Math.round(
          launches.reduce(
            (sum, row) => sum + toNumberOrZero(row.launchQuality?.score),
            0,
          ) / launches.length,
        )
      : 0;

    const payload = {
      meta: {
        recentDays,
        dateFrom: currentRange.start.toISOString().slice(0, 10),
        dateTo: currentRange.end.toISOString().slice(0, 10),
        periodLabel: `${normalizeDateLabel(currentRange.start)} ate ${normalizeDateLabel(currentRange.end)}`,
      },
      summary: {
        totalLaunches: launches.length,
        revenue: totalRevenueCents / 100,
        growingCount,
        weakCount,
        averageQuality,
        launchRevenueSharePct,
        previousLaunchRevenueSharePct,
        launchRevenueShareMoMPct,
        previousTotalLaunches: previousLaunches.length,
        launchesCountMoMPct,
      },
      items: launches,
    };

    if (summaryOnly) {
      delete payload.items;
    }

    res.json(payload);
  } catch (error) {
    console.error("products.launches failed:", error);
    res.status(500).json({
      error: "launches_failed",
      message: String(error?.message || error),
    });
  }
}

async function relaunchPause(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const { productIds, concurrency: concurrencyRaw } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        error: "invalid_product_ids",
        message: "productIds array e obrigatorio e nao pode estar vazio",
      });
    }

    const normalizedProductIds = dedupPreserveOrder(
      productIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
    const products = await listProductItemIdsByDbIds(shop.id, normalizedProductIds);
    const shopeeShopId = String(shop.shopId);
    const concurrency = Math.min(
      8,
      Math.max(1, Number.isFinite(Number(concurrencyRaw)) ? Number(concurrencyRaw) : 4),
    );
    const missingProducts = Math.max(0, normalizedProductIds.length - products.length);
    const logs = [];

    if (missingProducts > 0) {
      logs.push({
        ok: false,
        itemId: null,
        message: `${missingProducts} produto(s) nao encontrado(s) no banco para esta loja.`,
      });
    }

    const results = await mapWithConcurrency(
      products,
      concurrency,
      async (product) => {
        const itemId = Number(product?.itemId);
        const status = normalizeProductStatus(product?.status);
        if (!Number.isFinite(itemId) || itemId <= 0) {
          return {
            ok: false,
            itemId: product?.itemId != null ? String(product.itemId) : null,
            message: "item_id invalido para pausa",
          };
        }

        if (isAlreadyUnlistedStatus(status)) {
          return {
            ok: true,
            itemId: String(itemId),
            status,
            message: "item ja estava pausado (status unlist)",
          };
        }

        try {
          const payload = await ShopeeProductWriteService.unlistItem({
            shopId: shopeeShopId,
            body: { item_id: itemId, unlist: true },
          });
          return {
            ok: true,
            itemId: String(itemId),
            status,
            requestId: payload?.request_id || null,
            message: "pausado",
          };
        } catch (error) {
          console.error(`Failed to pause item ${itemId}:`, error);
          return {
            ok: false,
            itemId: String(itemId),
            status,
            message: parseShopeeErrorMessage(error),
          };
        }
      },
    );

    logs.push(...results);
    const paused = results.filter((result) => result?.ok).length;
    const failed =
      results.filter((result) => !result?.ok).length + Number(missingProducts || 0);

    res.json({
      paused,
      failed,
      totalRequested: normalizedProductIds.length,
      processed: results.length,
      missingProducts,
      logs,
    });
  } catch (error) {
    console.error("products.relaunchPause failed:", error);
    res.status(500).json({
      error: "relaunch_pause_failed",
      message: String(error?.message || error),
    });
  }
}

function normalizeListingStatusAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (["activate", "ativar", "publish", "publicar"].includes(action)) {
    return "activate";
  }
  if (["deactivate", "desativar", "pause", "pausar"].includes(action)) {
    return "deactivate";
  }
  if (["delete", "excluir", "remove", "remover"].includes(action)) {
    return "delete";
  }
  return "";
}

function parseListingStatusInputs(body = {}) {
  const rawIds = [
    ...(Array.isArray(body.itemIds) ? body.itemIds : []),
    ...(Array.isArray(body.ids) ? body.ids : []),
    ...parseCommaSeparatedValues(body.itemIdsCsv ?? body.idsCsv ?? body.idsText),
  ];
  const rawSkus = [
    ...(Array.isArray(body.skus) ? body.skus : []),
    ...parseCommaSeparatedValues(body.skusCsv ?? body.skusText),
  ];
  const itemIds = dedupPreserveOrder(
    rawIds
      .map((value) => String(value || "").trim())
      .filter((value) => /^\d+$/.test(value)),
  );
  const invalidIds = dedupPreserveOrder(
    rawIds
      .map((value) => String(value || "").trim())
      .filter((value) => value && !/^\d+$/.test(value)),
  );
  const skus = dedupPreserveOrder(
    rawSkus
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );

  return { itemIds, invalidIds, skus };
}

async function bulkListingStatus(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const action = normalizeListingStatusAction(req.body?.action);
    if (!action) {
      return res.status(400).json({
        error: "invalid_action",
        message: "Informe uma acao valida: activate, deactivate ou delete.",
      });
    }

    const { itemIds, invalidIds, skus } = parseListingStatusInputs(req.body || {});
    if (!itemIds.length && !skus.length) {
      return res.status(400).json({
        error: "empty_identifiers",
        message: "Informe ao menos um ID de produto ou SKU.",
      });
    }

    const products = await listProductsByShopAndIdentifiers(shop.id, {
      itemIds,
      skus,
    });
    const foundItemIds = new Set(
      products.map((product) => String(product?.itemId || "")).filter(Boolean),
    );
    const foundSkus = new Set(
      products
        .flatMap((product) => [product?.itemSku, product?.matchedSku])
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean),
    );
    const missingIds = itemIds.filter((itemId) => !foundItemIds.has(String(itemId)));
    const missingSkus = skus.filter(
      (sku) => !foundSkus.has(String(sku || "").trim().toUpperCase()),
    );
    const concurrency = Math.min(
      8,
      Math.max(1, Number.isFinite(Number(req.body?.concurrency)) ? Number(req.body.concurrency) : 4),
    );
    const shopeeShopId = String(shop.shopId);
    const logs = [];

    invalidIds.forEach((value) => {
      logs.push({
        ok: false,
        itemId: null,
        sku: null,
        message: `ID invalido ignorado: ${value}`,
      });
    });
    missingIds.forEach((itemId) => {
      logs.push({
        ok: false,
        itemId: String(itemId),
        sku: null,
        message: "Produto nao encontrado no banco para esta loja.",
      });
    });
    missingSkus.forEach((sku) => {
      logs.push({
        ok: false,
        itemId: null,
        sku: String(sku),
        message: "SKU nao encontrado no banco para esta loja.",
      });
    });

    const results = await mapWithConcurrency(
      products,
      concurrency,
      async (product) => {
        const itemId = Number(product?.itemId);
        const status = normalizeProductStatus(product?.status);
        const baseLog = {
          itemId: product?.itemId != null ? String(product.itemId) : null,
          sku: product?.matchedSku || product?.itemSku || null,
          title: product?.title || null,
          status,
          action,
        };

        if (!Number.isFinite(itemId) || itemId <= 0) {
          return {
            ...baseLog,
            ok: false,
            message: "item_id invalido para alteracao de status",
          };
        }

        try {
          if (action === "delete") {
            if (!isAlreadyUnlistedStatus(status)) {
              await ShopeeProductWriteService.unlistItem({
                shopId: shopeeShopId,
                body: { item_id: itemId, unlist: true },
              });
            }
            const payload = await ShopeeProductWriteService.deleteItem({
              shopId: shopeeShopId,
              body: { item_id: itemId },
            });
            return {
              ...baseLog,
              ok: true,
              requestId: payload?.request_id || null,
              message: "excluido",
            };
          }

          const shouldUnlist = action === "deactivate";
          const payload = await ShopeeProductWriteService.unlistItem({
            shopId: shopeeShopId,
            body: { item_id: itemId, unlist: shouldUnlist },
          });
          return {
            ...baseLog,
            ok: true,
            requestId: payload?.request_id || null,
            message: shouldUnlist ? "desativado/pausado" : "ativado/publicado",
          };
        } catch (error) {
          console.error(`Failed bulk listing status ${action} item ${itemId}:`, error);
          return {
            ...baseLog,
            ok: false,
            message: parseShopeeErrorMessage(error),
          };
        }
      },
    );

    logs.push(...results);
    const success = results.filter((result) => result?.ok).length;
    const failed = logs.filter((result) => !result?.ok).length;

    res.json({
      action,
      success,
      failed,
      processed: results.length,
      totalRequested: itemIds.length + skus.length,
      missingIds,
      missingSkus,
      invalidIds,
      logs,
    });
  } catch (error) {
    console.error("products.bulkListingStatus failed:", error);
    res.status(500).json({
      error: "bulk_listing_status_failed",
      message: String(error?.message || error),
    });
  }
}

async function relaunchDelete(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const { productIds, concurrency: concurrencyRaw } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        error: "invalid_product_ids",
        message: "productIds array e obrigatorio e nao pode estar vazio",
      });
    }

    const normalizedProductIds = dedupPreserveOrder(
      productIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
    const products = await listProductItemIdsByDbIds(shop.id, normalizedProductIds);
    const shopeeShopId = String(shop.shopId);
    const concurrency = Math.min(
      8,
      Math.max(1, Number.isFinite(Number(concurrencyRaw)) ? Number(concurrencyRaw) : 4),
    );
    const missingProducts = Math.max(0, normalizedProductIds.length - products.length);
    const logs = [];

    if (missingProducts > 0) {
      logs.push({
        ok: false,
        itemId: null,
        message: `${missingProducts} produto(s) nao encontrado(s) no banco para esta loja.`,
      });
    }

    const results = await mapWithConcurrency(
      products,
      concurrency,
      async (product) => {
        const itemId = Number(product?.itemId);
        const status = normalizeProductStatus(product?.status);
        if (!Number.isFinite(itemId) || itemId <= 0) {
          return {
            ok: false,
            itemId: product?.itemId != null ? String(product.itemId) : null,
            message: "item_id invalido para exclusao",
          };
        }

        try {
          if (!isAlreadyUnlistedStatus(status)) {
            try {
              await ShopeeProductWriteService.unlistItem({
                shopId: shopeeShopId,
                body: { item_id: itemId, unlist: true },
              });
            } catch (unlistError) {
              return {
                ok: false,
                itemId: String(itemId),
                status,
                message: `nao foi possivel pausar antes de excluir: ${parseShopeeErrorMessage(unlistError)}`,
              };
            }
          }

          const payload = await ShopeeProductWriteService.deleteItem({
            shopId: shopeeShopId,
            body: { item_id: itemId },
          });
          return {
            ok: true,
            itemId: String(itemId),
            status,
            requestId: payload?.request_id || null,
            message: "excluido",
          };
        } catch (error) {
          console.error(`Failed to delete item ${itemId}:`, error);
          return {
            ok: false,
            itemId: String(itemId),
            status,
            message: parseShopeeErrorMessage(error),
          };
        }
      },
    );

    logs.push(...results);
    const deleted = results.filter((result) => result?.ok).length;
    const failed =
      results.filter((result) => !result?.ok).length + Number(missingProducts || 0);

    res.json({
      deleted,
      failed,
      totalRequested: normalizedProductIds.length,
      processed: results.length,
      missingProducts,
      logs,
    });
  } catch (error) {
    console.error("products.relaunchDelete failed:", error);
    res.status(500).json({
      error: "relaunch_delete_failed",
      message: String(error?.message || error),
    });
  }
}

module.exports = {
  list,
  exportFiltered,
  detail,
  fullDetail,
  updateItem,
  updatePrice,
  updateStock,
  uploadAndApplyImages,
  addImages,
  removeImages,
  performance,
  curvesAbc,
  relaunch,
  launches,
  deadlineControlPreview,
  deadlineControlApply,
  salesShare,
  salesControl,
  bulkListingStatus,
  relaunchPause,
  relaunchDelete,
};
