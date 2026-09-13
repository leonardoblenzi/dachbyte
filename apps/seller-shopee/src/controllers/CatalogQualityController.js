const ShopeeProductService = require("../services/ShopeeProductService");
const ShopeeProductWriteService = require("../services/ShopeeProductWriteService");
const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const { query } = require("../config/postgres");
const {
  countCatalogProducts,
  findProductDetailByShopAndItemId,
  listCatalogProducts,
  updateProductByShopAndItemId,
} = require("../repositories/productSqlRepository");

const BASE_INFO_CACHE_TTL_MS = 10 * 60 * 1000;
const FILTER_CACHE_TTL_MS = 2 * 60 * 1000;
const BASE_INFO_CACHE = new Map();
const FILTER_RESULT_CACHE = new Map();

function onlyDigits(v) {
  return /^\d+$/.test(String(v ?? "").trim());
}

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }

  const shop = await findShopForAccountById(shopDbId, req.auth.accountId);

  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

function getAttributeValues(attr) {
  if (!Array.isArray(attr?.attribute_value_list)) return [];
  return attr.attribute_value_list
    .map(
      (value) =>
        value?.original_value_name ||
        value?.value_name ||
        value?.value ||
        value?.display_value ||
        "",
    )
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function getAttributeName(attr) {
  return (
    attr?.original_attribute_name ||
    attr?.attribute_name ||
    attr?.attribute_id ||
    "Atributo"
  );
}

function detectClip(baseInfo) {
  if (!baseInfo) return false;

  if (Array.isArray(baseInfo.video_info_list) && baseInfo.video_info_list.length) {
    return true;
  }

  if (Array.isArray(baseInfo.video_list) && baseInfo.video_list.length) return true;
  if (baseInfo.video_info && Object.keys(baseInfo.video_info).length) return true;
  if (baseInfo.video_upload_id || baseInfo.video_id) return true;

  return false;
}

function normalizeItemIds(itemIds = []) {
  return Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((value) => String(value || "").trim())
        .filter((value) => /^\d+$/.test(value)),
    ),
  );
}

function makeBaseInfoCacheKey(shopShopeeId, itemId) {
  return `${String(shopShopeeId)}:${String(itemId)}`;
}

function cleanupExpiredCache(map) {
  const now = Date.now();
  for (const [key, entry] of map.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      map.delete(key);
    }
  }
}

function makeFilterCacheKey(shopDbId, q, scoreFilter) {
  return `${String(shopDbId)}|${String(scoreFilter || "all")}|${String(q || "")
    .trim()
    .toLowerCase()}`;
}

function invalidateCatalogQualityCachesForShop(shop) {
  const shopDbId = String(shop?.id || "");
  const shopShopeeId = String(shop?.shopId || "");

  for (const key of FILTER_RESULT_CACHE.keys()) {
    if (shopDbId && key.startsWith(`${shopDbId}|`)) {
      FILTER_RESULT_CACHE.delete(key);
    }
  }

  for (const key of BASE_INFO_CACHE.keys()) {
    if (shopShopeeId && key.startsWith(`${shopShopeeId}:`)) {
      BASE_INFO_CACHE.delete(key);
    }
  }
}

function chunkArray(values = [], size = 50) {
  const list = Array.isArray(values) ? values : [];
  const chunkSize = Math.max(1, Number(size) || 50);
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

function normalizeScoreFilter(value) {
  const normalized = String(value || "all")
    .trim()
    .toLowerCase();
  if (["excellent", "good", "critical"].includes(normalized)) {
    return normalized;
  }
  return "all";
}

function scoreMatchesFilter(score, scoreFilter = "all") {
  const n = Number(score || 0);
  if (scoreFilter === "excellent") return n > 85;
  if (scoreFilter === "good") return n >= 60 && n <= 85;
  if (scoreFilter === "critical") return n < 60;
  return true;
}

async function loadDiscountParticipationMap(shopId, itemIds = []) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return new Map();
  try {
    const result = await query(
      `
        SELECT
          di."itemId"::text AS item_id,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT dc.status), NULL) AS statuses
        FROM "DiscountItem" di
        INNER JOIN "DiscountCampaign" dc ON dc.id = di."campaignId"
        WHERE dc."shopId" = $1
          AND di."itemId" = ANY($2::bigint[])
        GROUP BY di."itemId"
      `,
      [Number(shopId), normalizedItemIds],
    );

    return new Map(
      result.rows.map((row) => {
        const statuses = Array.isArray(row.statuses)
          ? row.statuses
              .map((status) => String(status || "").trim().toLowerCase())
              .filter(Boolean)
          : [];
        const hasDiscountCampaign = statuses.some((status) =>
          ["draft", "upcoming", "ongoing"].includes(status),
        );
        return [
          String(row.item_id),
          {
            hasDiscountCampaign,
            campaignStatuses: statuses,
          },
        ];
      }),
    );
  } catch (error) {
    console.error("catalogQuality.discountParticipation failed:", error);
    return new Map();
  }
}

function buildQuality(product, baseInfo = null, discountInfo = null) {
  const attrs = Array.isArray(product.attributes) ? product.attributes : [];
  const filledAttrs = attrs.filter((attr) => getAttributeValues(attr).length > 0);
  const mandatoryMissing = attrs
    .filter((attr) => attr?.is_mandatory && getAttributeValues(attr).length === 0)
    .map((attr) => getAttributeName(attr));

  const hasClip = detectClip(baseInfo);
  const brandFilled = Boolean(String(product.brand || "").trim());
  const enoughAttrs = filledAttrs.length >= 5;
  const enoughImages = (product.images || []).length > 3;
  const titleLength = String(product.title || "").trim().length;
  const titleOptimal = titleLength >= 80 && titleLength <= 100;
  const hasMissingMandatory = mandatoryMissing.length > 0;
  const hasDiscountCampaign = Boolean(discountInfo?.hasDiscountCampaign);
  const campaignStatuses = Array.isArray(discountInfo?.campaignStatuses)
    ? discountInfo.campaignStatuses
    : [];

  let score = 100;
  if (!hasClip) score -= 15;
  if (!brandFilled) score -= 15;
  if (!enoughAttrs) score -= 20;
  if (!enoughImages) score -= 15;
  if (!titleOptimal) score -= 15;
  if (hasMissingMandatory) score -= 20;
  score = Math.max(0, Math.min(100, score));

  const checks = {
    hasClip,
    brandFilled,
    enoughAttrs,
    enoughImages,
    titleOptimal,
    hasDiscountCampaign,
    campaignStatuses,
    missingMandatoryCount: mandatoryMissing.length,
  };

  const missing = [];
  if (!hasClip) missing.push("Sem clip");
  if (!brandFilled) missing.push("Marca não preenchida");
  if (!enoughAttrs) missing.push("Menos de 5 atributos preenchidos");
  if (!enoughImages) missing.push("Menos de 4 imagens");
  if (!titleOptimal) missing.push("Título fora de 80-100 caracteres");
  if (hasMissingMandatory) {
    missing.push(
      `Atributos obrigatórios pendentes: ${mandatoryMissing.join(", ")}`,
    );
  }

  return {
    score,
    checks,
    missing,
    metrics: {
      titleLength,
      filledAttributeCount: filledAttrs.length,
      imageCount: (product.images || []).length,
      mandatoryMissing,
      campaignStatuses,
    },
  };
}

async function loadBaseInfoMap(shop, itemIds) {
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) return new Map();

  const result = new Map();
  const chunks = chunkArray(normalized, 50);

  for (const ids of chunks) {
    try {
      const response = await ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: ids,
      });

      const items =
        response?.response?.item_list ||
        response?.response?.items ||
        response?.response ||
        [];

      (Array.isArray(items) ? items : [])
        .filter((item) => item?.item_id != null)
        .forEach((item) => {
          result.set(String(item.item_id), item);
        });
    } catch (_) {
      // ignora erros de lote para não derrubar toda a listagem
    }
  }

  return result;
}

async function listWithoutClip(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const total = await countCatalogProducts(shop.id, "", { includeInactive: false });
    const products = [];
    const pageSize = 200;
    for (let skip = 0; skip < total; skip += pageSize) {
      const batch = await listCatalogProducts(shop.id, {
        q: "",
        skip,
        take: pageSize,
        includeInactive: false,
      });
      if (!Array.isArray(batch) || !batch.length) break;
      products.push(...batch);
      if (batch.length < pageSize) break;
    }

    const itemIds = products.map((product) => String(product.itemId || "")).filter(onlyDigits);
    const baseInfoMap = await loadBaseInfoMap(shop, itemIds);
    let unavailable = 0;
    let withClip = 0;
    const unavailableItemIds = [];
    const items = [];

    for (const product of products) {
      const itemId = String(product.itemId || "");
      if (!baseInfoMap.has(itemId)) {
        unavailable += 1;
        unavailableItemIds.push(itemId);
        continue;
      }
      if (detectClip(baseInfoMap.get(itemId))) {
        withClip += 1;
        continue;
      }
      items.push({
        itemId,
        title: product.title || `Item ${itemId}`,
        imageUrl: product.images?.[0]?.url || null,
      });
    }

    return res.json({
      items,
      itemIds: items.map((item) => item.itemId),
      unavailableItemIds,
      meta: { total: products.length, withoutClip: items.length, withClip, unavailable },
    });
  } catch (error) {
    console.error("catalogQuality.listWithoutClip failed:", error);
    return res.status(500).json({
      error: "clips_without_clip_failed",
      message: String(error?.message || error),
    });
  }
}

async function listClipProducts(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const q = String(req.query?.q || "").trim();
    const pageRaw = Number(req.query?.page || 1);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const pageSizeRaw = Number(req.query?.pageSize || 100);
    const pageSize = Math.max(1, Math.min(100, Math.floor(pageSizeRaw) || 100));
    const total = await countCatalogProducts(shop.id, q, { includeInactive: false });
    const products = await listCatalogProducts(shop.id, {
      q,
      skip: (page - 1) * pageSize,
      take: pageSize,
      includeInactive: false,
    });
    const itemIds = products.map((product) => String(product.itemId || "")).filter(onlyDigits);
    const baseInfoMap = await loadBaseInfoMap(shop, itemIds);
    const items = products.map((product) => {
      const itemId = String(product.itemId || "");
      const clipStatusKnown = baseInfoMap.has(itemId);
      return {
        itemId,
        title: product.title || `Item ${itemId}`,
        imageUrl: product.images?.[0]?.url || null,
        hasClip: clipStatusKnown ? detectClip(baseInfoMap.get(itemId)) : null,
        clipStatusKnown,
      };
    });

    return res.json({
      items,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    console.error("catalogQuality.listClipProducts failed:", error);
    return res.status(500).json({
      error: "clip_products_search_failed",
      message: String(error?.message || error),
    });
  }
}

async function loadBaseInfoMapCached(shop, itemIds) {
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) return new Map();

  cleanupExpiredCache(BASE_INFO_CACHE);
  const now = Date.now();

  const result = new Map();
  const missing = [];

  for (const itemId of normalized) {
    const cacheKey = makeBaseInfoCacheKey(shop.shopId, itemId);
    const cached = BASE_INFO_CACHE.get(cacheKey);
    if (cached && Number(cached.expiresAt || 0) > now) {
      result.set(String(itemId), cached.value || null);
      continue;
    }
    missing.push(itemId);
  }

  const chunks = chunkArray(missing, 50);
  for (const ids of chunks) {
    try {
      const response = await ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: ids,
      });
      const items =
        response?.response?.item_list ||
        response?.response?.items ||
        response?.response ||
        [];

      for (const item of Array.isArray(items) ? items : []) {
        if (item?.item_id == null) continue;
        const key = String(item.item_id);
        result.set(key, item);
        BASE_INFO_CACHE.set(makeBaseInfoCacheKey(shop.shopId, key), {
          value: item,
          expiresAt: Date.now() + BASE_INFO_CACHE_TTL_MS,
        });
      }
    } catch (_) {
      // ignora erros de lote para nao derrubar toda a listagem
    }
  }

  return result;
}

function normalizeEditableAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];

  return attributes.map((attr) => ({
    attributeId: attr?.attribute_id != null ? String(attr.attribute_id) : null,
    name: getAttributeName(attr),
    isMandatory: Boolean(attr?.is_mandatory),
    values: getAttributeValues(attr),
    sourceAttribute:
      attr && typeof attr === "object" ? JSON.parse(JSON.stringify(attr)) : null,
  }));
}

function normalizeCompareToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function makeAttributeLookupKey(attributeId, name) {
  const id = String(attributeId || "").trim();
  if (id) return `id:${id}`;
  return `name:${normalizeCompareToken(name)}`;
}

function buildExistingAttributeLookup(attributes = []) {
  const map = new Map();
  for (const raw of Array.isArray(attributes) ? attributes : []) {
    const attributeId =
      raw?.attribute_id != null ? String(raw.attribute_id).trim() : "";
    const name = getAttributeName(raw);
    if (attributeId) {
      map.set(makeAttributeLookupKey(attributeId, ""), raw);
    }
    const normalizedName = normalizeCompareToken(name);
    if (normalizedName) {
      map.set(makeAttributeLookupKey("", normalizedName), raw);
    }
  }
  return map;
}

function normalizeSubmittedValues(values) {
  const list = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((entry) => entry.trim());
  return Array.from(
    new Set(
      list
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
}

function mapSourceValues(sourceValues = []) {
  const byLabel = new Map();
  const labels = [];
  for (const sourceValue of Array.isArray(sourceValues) ? sourceValues : []) {
    const label = String(
      sourceValue?.original_value_name ||
        sourceValue?.value_name ||
        sourceValue?.value ||
        sourceValue?.display_value ||
        "",
    ).trim();
    if (!label) continue;
    labels.push(label);
    const key = normalizeCompareToken(label);
    if (!byLabel.has(key)) {
      byLabel.set(key, sourceValue);
    }
  }
  return { byLabel, labels };
}

function sameValueSet(left = [], right = []) {
  const normLeft = Array.from(new Set(left.map(normalizeCompareToken).filter(Boolean))).sort();
  const normRight = Array.from(
    new Set(right.map(normalizeCompareToken).filter(Boolean)),
  ).sort();
  if (normLeft.length !== normRight.length) return false;
  return normLeft.every((value, index) => value === normRight[index]);
}

function buildAttributeValueListFromInput(values, sourceAttribute) {
  const normalizedValues = normalizeSubmittedValues(values);
  if (!normalizedValues.length) return [];

  const sourceValueList = Array.isArray(sourceAttribute?.attribute_value_list)
    ? sourceAttribute.attribute_value_list
    : [];
  const { byLabel, labels } = mapSourceValues(sourceValueList);

  if (sourceValueList.length && sameValueSet(normalizedValues, labels)) {
    return sourceValueList.map((entry) =>
      entry && typeof entry === "object"
        ? JSON.parse(JSON.stringify(entry))
        : entry,
    );
  }

  return normalizedValues.map((value) => {
    const existing = byLabel.get(normalizeCompareToken(value));
    if (existing && typeof existing === "object") {
      const cloned = JSON.parse(JSON.stringify(existing));
      if (!cloned.original_value_name) cloned.original_value_name = value;
      if (!cloned.value_name) cloned.value_name = value;
      return cloned;
    }
    return {
      value_name: value,
      original_value_name: value,
    };
  });
}

async function loadCategoryAttributes(shop, categoryId) {
  if (!onlyDigits(categoryId)) return [];
  try {
    let response;
    try {
      response = await ShopeeProductService.getAttributeTree({
        shopId: String(shop.shopId),
        categoryId: String(categoryId),
      });
    } catch (_treeError) {
      response = await ShopeeProductService.getAttributes({
        shopId: String(shop.shopId),
        categoryId: String(categoryId),
      });
    }
    const attrs =
      response?.response?.attribute_tree ||
      response?.response?.list?.[0]?.attribute_tree ||
      response?.response?.attribute_list ||
      response?.response?.attributes ||
      response?.response ||
      [];
    return Array.isArray(attrs) ? attrs : [];
  } catch (error) {
    console.warn("catalogQuality.loadCategoryAttributes failed:", error?.message || error);
    return [];
  }
}

function mergeEditableAttributes(productAttributes = [], categoryAttributes = []) {
  const productEditable = normalizeEditableAttributes(productAttributes);
  if (!Array.isArray(categoryAttributes) || !categoryAttributes.length) {
    return productEditable;
  }

  const productMap = new Map();
  for (const attr of productEditable) {
    productMap.set(makeAttributeLookupKey(attr.attributeId, attr.name), attr);
  }

  const merged = [];
  const consumed = new Set();
  for (const categoryAttr of categoryAttributes) {
    const normalizedCategory = {
      attributeId:
        categoryAttr?.attribute_id != null ? String(categoryAttr.attribute_id) : null,
      name: getAttributeName(categoryAttr),
      isMandatory: Boolean(categoryAttr?.is_mandatory ?? categoryAttr?.mandatory),
      values: [],
      sourceAttribute:
        categoryAttr && typeof categoryAttr === "object"
          ? JSON.parse(JSON.stringify(categoryAttr))
          : null,
    };

    const key = makeAttributeLookupKey(
      normalizedCategory.attributeId,
      normalizedCategory.name,
    );
    const existing = productMap.get(key);
    if (existing) {
      merged.push({
        ...normalizedCategory,
        values: Array.isArray(existing.values) ? existing.values : [],
        sourceAttribute: existing.sourceAttribute || normalizedCategory.sourceAttribute,
        isMandatory: normalizedCategory.isMandatory || existing.isMandatory,
      });
      consumed.add(key);
      continue;
    }

    merged.push(normalizedCategory);
  }

  for (const attr of productEditable) {
    const key = makeAttributeLookupKey(attr.attributeId, attr.name);
    if (consumed.has(key)) continue;
    merged.push(attr);
  }

  return merged;
}

async function list(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const pageRaw = Number(req.query.page || 1);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const pageSizeRaw = Number(req.query.pageSize || 24);
    const pageSize = [12, 24, 48].includes(pageSizeRaw) ? pageSizeRaw : 24;
    const skip = (page - 1) * pageSize;
    const scoreFilter = normalizeScoreFilter(req.query.scoreFilter);

    const q = String(req.query.q || "").trim();
    const totalCatalogItems = await countCatalogProducts(shop.id, q);
    cleanupExpiredCache(FILTER_RESULT_CACHE);
    const filterCacheKey = makeFilterCacheKey(shop.id, q, scoreFilter);

    if (scoreFilter === "all") {
      const products = await listCatalogProducts(shop.id, { q, skip, take: pageSize });
      const itemIds = products
        .map((product) => Number(product.itemId))
        .filter((value) => Number.isFinite(value));
      const baseInfoMap = await loadBaseInfoMapCached(shop, itemIds);
      const discountMap = await loadDiscountParticipationMap(shop.id, itemIds);

      const items = products.map((product) => {
        const quality = buildQuality(
          product,
          baseInfoMap.get(String(product.itemId)),
          discountMap.get(String(product.itemId)),
        );
        return {
          itemId: String(product.itemId),
          sku: product.itemSku || null,
          title: product.title || `Item ${product.itemId}`,
          brand: product.brand || null,
          imageUrl: product.images?.[0]?.url || null,
          updatedAt: product.updatedAt,
          quality,
        };
      });

      const averageScore = items.length
        ? Math.round(
            items.reduce((sum, item) => sum + Number(item.quality.score || 0), 0) /
              items.length,
          )
        : 0;

      return res.json({
        items,
        meta: {
          page,
          pageSize,
          total: totalCatalogItems,
          totalPages: Math.max(1, Math.ceil(totalCatalogItems / pageSize)),
          averageScore,
          lowScoreCount: items.filter((item) => item.quality.score < 60).length,
          scoreFilter,
          totalCatalogItems,
        },
      });
    }

    let filteredItems = null;
    const cachedFilter = FILTER_RESULT_CACHE.get(filterCacheKey);
    if (
      cachedFilter &&
      Number(cachedFilter.expiresAt || 0) > Date.now() &&
      Array.isArray(cachedFilter.items)
    ) {
      filteredItems = cachedFilter.items;
    } else {
      const scanPageSize = 200;
      const allProducts = [];
      for (let offset = 0; offset < totalCatalogItems; offset += scanPageSize) {
        const batch = await listCatalogProducts(shop.id, {
          q,
          skip: offset,
          take: scanPageSize,
        });
        if (!Array.isArray(batch) || !batch.length) break;
        allProducts.push(...batch);
        if (batch.length < scanPageSize) break;
      }

      const allItemIds = allProducts
        .map((product) => Number(product.itemId))
        .filter((value) => Number.isFinite(value));
      const allBaseInfoMap = await loadBaseInfoMapCached(shop, allItemIds);
      const allDiscountMap = await loadDiscountParticipationMap(shop.id, allItemIds);

      const scoredItems = allProducts.map((product) => {
        const quality = buildQuality(
          product,
          allBaseInfoMap.get(String(product.itemId)),
          allDiscountMap.get(String(product.itemId)),
        );
        return {
          itemId: String(product.itemId),
          sku: product.itemSku || null,
          title: product.title || `Item ${product.itemId}`,
          brand: product.brand || null,
          imageUrl: product.images?.[0]?.url || null,
          updatedAt: product.updatedAt,
          quality,
        };
      });

      filteredItems = scoredItems.filter((item) =>
        scoreMatchesFilter(item.quality.score, scoreFilter),
      );
      FILTER_RESULT_CACHE.set(filterCacheKey, {
        items: filteredItems,
        expiresAt: Date.now() + FILTER_CACHE_TTL_MS,
      });
    }

    const pagedItems = filteredItems.slice(skip, skip + pageSize);
    const averageScore = pagedItems.length
      ? Math.round(
          pagedItems.reduce((sum, item) => sum + Number(item.quality.score || 0), 0) /
            pagedItems.length,
        )
      : 0;

    return res.json({
      items: pagedItems,
      meta: {
        page,
        pageSize,
        total: filteredItems.length,
        totalPages: Math.max(1, Math.ceil(filteredItems.length / pageSize)),
        averageScore,
        lowScoreCount: pagedItems.filter((item) => item.quality.score < 60).length,
        scoreFilter,
        totalCatalogItems,
      },
    });
  } catch (e) {
    console.error("catalogQuality.list failed:", e);
    res.status(500).json({
      error: "catalog_quality_list_failed",
      message: String(e?.message || e),
    });
  }
}

async function detail(req, res) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const product = await findProductDetailByShopAndItemId(shop.id, itemId);

    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }

    const baseInfoMap = await loadBaseInfoMapCached(shop, [Number(itemId)]);
    const baseInfo = baseInfoMap.get(String(itemId)) || null;
    const resolvedCategoryId =
      product.categoryId != null
        ? String(product.categoryId)
        : onlyDigits(baseInfo?.category_id)
          ? String(baseInfo.category_id)
          : null;
    const categoryAttributes = await loadCategoryAttributes(shop, resolvedCategoryId);
    const editableAttributes = mergeEditableAttributes(
      product.attributes,
      categoryAttributes,
    );
    const discountMap = await loadDiscountParticipationMap(shop.id, [itemId]);
    const quality = buildQuality(
      product,
      baseInfo,
      discountMap.get(String(itemId)),
    );

    res.json({
      product: {
        itemId: String(product.itemId),
        sku: product.itemSku || null,
        title: product.title || "",
        description: product.description || "",
        brand: product.brand || "",
        categoryId: resolvedCategoryId,
        categoryName: String(baseInfo?.category_name || "").trim() || null,
        clip: {
          hasClip: detectClip(baseInfo),
          videoUploadId:
            baseInfo?.video_upload_id != null
              ? String(baseInfo.video_upload_id)
              : null,
          videoId: baseInfo?.video_id != null ? String(baseInfo.video_id) : null,
        },
        images: product.images || [],
        attributes: editableAttributes,
      },
      quality,
    });
  } catch (e) {
    console.error("catalogQuality.detail failed:", e);
    res.status(500).json({
      error: "catalog_quality_detail_failed",
      message: String(e?.message || e),
    });
  }
}

async function exportReport(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const totalCatalogItems = await countCatalogProducts(shop.id, "", {
      includeInactive: false,
    });
    const scanPageSize = 200;
    const allRows = [];

    for (let offset = 0; offset < totalCatalogItems; offset += scanPageSize) {
      // eslint-disable-next-line no-await-in-loop
      const products = await listCatalogProducts(shop.id, {
        q: "",
        skip: offset,
        take: scanPageSize,
        includeInactive: false,
      });

      if (!Array.isArray(products) || !products.length) break;

      const itemIds = products
        .map((product) => Number(product.itemId))
        .filter((value) => Number.isFinite(value));

      const [baseInfoMap, discountMap] = await Promise.all([
        loadBaseInfoMapCached(shop, itemIds),
        loadDiscountParticipationMap(shop.id, itemIds),
      ]);

      for (const product of products) {
        const baseInfo = baseInfoMap.get(String(product.itemId)) || null;
        const quality = buildQuality(
          product,
          baseInfo,
          discountMap.get(String(product.itemId)),
        );

        const mandatoryMissing = Array.isArray(quality?.metrics?.mandatoryMissing)
          ? quality.metrics.mandatoryMissing.filter(Boolean)
          : [];
        const missing = Array.isArray(quality?.missing)
          ? quality.missing.filter(Boolean)
          : [];

        allRows.push({
          item_id: String(product.itemId || ""),
          nome: String(product.title || `Item ${product.itemId}`),
          marca: String(product.brand || ""),
          indice_qualidade: Number(quality?.score || 0),
          possui_clip: quality?.checks?.hasClip ? "SIM" : "NAO",
          possui_marca: quality?.checks?.brandFilled ? "SIM" : "NAO",
          qtd_imagens: Number(quality?.metrics?.imageCount || 0),
          qtd_atributos_preenchidos: Number(
            quality?.metrics?.filledAttributeCount || 0,
          ),
          faltam_atributos_obrigatorios: mandatoryMissing.length ? "SIM" : "NAO",
          atributos_obrigatorios_pendentes: mandatoryMissing.join(" | "),
          pendencias: missing.join(" | "),
          atualizado_em: product.updatedAt
            ? new Date(product.updatedAt).toISOString()
            : null,
        });
      }
    }

    return res.json({
      items: allRows,
      meta: {
        totalRows: allRows.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("catalogQuality.exportReport failed:", e);
    return res.status(500).json({
      error: "catalog_quality_export_failed",
      message: String(e?.message || e),
    });
  }
}

async function update(req, res) {
  try {
    const { itemId } = req.params;
    if (!onlyDigits(itemId)) {
      return res.status(400).json({ error: "itemId_invalid" });
    }

    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const product = await findProductDetailByShopAndItemId(shop.id, itemId);
    if (!product) {
      return res.status(404).json({ error: "product_not_found" });
    }

    const itemName = String(req.body?.itemName || "").trim();
    const description = String(req.body?.description || "").trim();
    const brand = String(req.body?.brand || "").trim();
    const categoryId = String(req.body?.categoryId || "").trim();
    const videoUploadId = String(req.body?.videoUploadId || "").trim();
    const attributes = Array.isArray(req.body?.attributes) ? req.body.attributes : [];

    const existingLookup = buildExistingAttributeLookup(product.attributes);
    const normalizedAttributes = [];
    const usedKeys = new Set();

    for (const attr of attributes) {
      const attributeId = String(attr?.attributeId || "").trim();
      const name = String(attr?.name || "").trim();
      const lookupKey = makeAttributeLookupKey(attributeId, name);
      if (usedKeys.has(lookupKey)) continue;
      usedKeys.add(lookupKey);

      const candidateSource =
        attr?.sourceAttribute && typeof attr.sourceAttribute === "object"
          ? attr.sourceAttribute
          : null;
      const sourceFromExisting = existingLookup.get(lookupKey) || null;
      const sourceAttribute = candidateSource || sourceFromExisting || {};

      const attributeValueList = buildAttributeValueListFromInput(
        attr?.values,
        sourceAttribute,
      );

      const normalized = {
        ...(sourceAttribute && typeof sourceAttribute === "object"
          ? JSON.parse(JSON.stringify(sourceAttribute))
          : {}),
        ...(attributeId ? { attribute_id: Number(attributeId) || attributeId } : {}),
        ...(name ? { original_attribute_name: name } : {}),
        attribute_value_list: attributeValueList,
        is_mandatory:
          typeof attr?.isMandatory === "boolean"
            ? attr.isMandatory
            : Boolean(sourceAttribute?.is_mandatory),
      };

      normalizedAttributes.push(normalized);
    }

    const attributeList = normalizedAttributes.filter(
      (attr) =>
        Array.isArray(attr?.attribute_value_list) &&
        attr.attribute_value_list.filter(Boolean).length > 0,
    );

    const payload = {
      item_id: Number(itemId),
      ...(itemName ? { item_name: itemName } : {}),
      ...(description ? { description } : {}),
      ...(attributeList.length ? { attribute_list: attributeList } : {}),
      ...(onlyDigits(categoryId) ? { category_id: Number(categoryId) } : {}),
      ...(videoUploadId ? { video_upload_id: videoUploadId } : {}),
      ...(brand
        ? {
            brand: {
              original_brand_name: brand,
            },
          }
        : {}),
    };

    const result = await ShopeeProductWriteService.updateItem({
      shopId: String(shop.shopId),
      body: payload,
    });

    const attributesForDb = normalizedAttributes.length
      ? normalizedAttributes
      : product.attributes || [];

    await updateProductByShopAndItemId(shop.id, itemId, {
      ...(itemName ? { title: itemName } : {}),
      ...(description ? { description } : {}),
      ...(brand ? { brand } : {}),
      ...(Object.prototype.hasOwnProperty.call(req.body || {}, "categoryId")
        ? {
            categoryId: onlyDigits(categoryId)
              ? categoryId
              : product.categoryId != null
                ? String(product.categoryId)
                : null,
          }
        : {}),
      ...(attributesForDb ? { attributes: attributesForDb } : {}),
    });

    invalidateCatalogQualityCachesForShop(shop);

    return res.json({ status: "ok", result });
  } catch (e) {
    console.error("catalogQuality.update failed:", e);
    return res.status(500).json({
      error: "catalog_quality_update_failed",
      message: String(e?.message || e),
    });
  }
}

module.exports = {
  list,
  listWithoutClip,
  listClipProducts,
  exportReport,
  detail,
  update,
};
