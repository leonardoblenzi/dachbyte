"use strict";

const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_PRODUCTS_PER_WORKSPACE = 5000;

const workspaceCatalogCache = new Map();

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || "").trim() || "default";
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeStatus(value) {
  return String(value || "draft").trim().toLowerCase() || "draft";
}

function normalizeSort(value, fallback = "updated_desc") {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "updated_desc",
    "updated_asc",
    "title_asc",
    "title_desc",
    "price_desc",
    "price_asc",
    "stock_desc",
    "stock_asc",
    "revenue_desc",
    "revenue_asc",
  ]);

  return allowed.has(normalized) ? normalized : fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isExpired(entry) {
  if (!entry) return true;
  return Date.now() - entry.updatedAt > CACHE_TTL_MS;
}

function ensureWorkspaceEntry(workspaceId) {
  const key = normalizeWorkspaceId(workspaceId);
  const current = workspaceCatalogCache.get(key);

  if (current && !isExpired(current)) {
    return current;
  }

  const fresh = {
    workspaceId: key,
    updatedAt: Date.now(),
    syncedAt: null,
    products: [],
    categories: [],
    productMap: new Map(),
  };

  workspaceCatalogCache.set(key, fresh);
  return fresh;
}

function normalizeCachedProduct(product = {}, index = 0) {
  const sku = sanitizeText(product.sku) || sanitizeText(product.externalId) || `cache-${index + 1}`;
  const id = sanitizeText(product.id) || `madcache_${sku}`;
  const images = Array.isArray(product.images) ? product.images : [];
  const attributes = Array.isArray(product.attributes) ? product.attributes : [];
  const currentPrice = toNumber(product.currentPrice);
  const compareAtPrice = product.compareAtPrice == null ? null : toNumber(product.compareAtPrice);
  const stock = Number.parseInt(String(product.stock || 0), 10) || 0;
  const soldUnits = Number.parseInt(String(product.soldUnits || 0), 10) || 0;
  const revenueAmount = toNumber(product.revenueAmount);

  return {
    id,
    workspaceId: normalizeWorkspaceId(product.workspaceId),
    externalId: sanitizeText(product.externalId),
    categoryId: sanitizeText(product.categoryId),
    categoryExternalId: sanitizeText(product.categoryExternalId),
    categoryName: sanitizeText(product.categoryName) || "Sem categoria",
    sku,
    ean: sanitizeText(product.ean),
    title: sanitizeText(product.title) || sku,
    description: sanitizeText(product.description),
    status: normalizeStatus(product.status),
    currentPrice,
    compareAtPrice,
    stock,
    weightGrams: product.weightGrams == null ? null : toNumber(product.weightGrams),
    heightCm: product.heightCm == null ? null : toNumber(product.heightCm),
    widthCm: product.widthCm == null ? null : toNumber(product.widthCm),
    lengthCm: product.lengthCm == null ? null : toNumber(product.lengthCm),
    payload: product.payload && typeof product.payload === "object" ? product.payload : {},
    marketplacePayload:
      product.marketplacePayload && typeof product.marketplacePayload === "object"
        ? product.marketplacePayload
        : null,
    lastSyncedAt: product.lastSyncedAt || new Date().toISOString(),
    createdAt: product.createdAt || new Date().toISOString(),
    updatedAt: product.updatedAt || new Date().toISOString(),
    imageCount: images.length,
    attributeCount: attributes.length,
    soldUnits,
    revenueAmount,
    images: images.map((image, imageIndex) =>
      typeof image === "string"
        ? {
            id: `${id}_img_${imageIndex + 1}`,
            url: image,
            altText: null,
            position: imageIndex,
            isPrimary: imageIndex === 0,
          }
        : {
            id: sanitizeText(image.id) || `${id}_img_${imageIndex + 1}`,
            url: sanitizeText(image.url),
            altText: sanitizeText(image.altText),
            position: Number.isFinite(Number(image.position)) ? Number(image.position) : imageIndex,
            isPrimary: Boolean(image.isPrimary ?? imageIndex === 0),
          },
    ).filter((image) => image.url),
    attributes: attributes
      .map((attribute, attributeIndex) => ({
        id: sanitizeText(attribute.id) || `${id}_attr_${attributeIndex + 1}`,
        externalAttributeId: sanitizeText(attribute.externalAttributeId),
        name: sanitizeText(attribute.name),
        value: sanitizeText(attribute.value),
        unit: sanitizeText(attribute.unit),
      }))
      .filter((attribute) => attribute.name && attribute.value),
  };
}

function storeCatalogSnapshot(workspaceId, input = {}) {
  const entry = ensureWorkspaceEntry(workspaceId);
  const normalizedProducts = (Array.isArray(input.products) ? input.products : [])
    .slice(0, MAX_PRODUCTS_PER_WORKSPACE)
    .map((product, index) =>
      normalizeCachedProduct(
        {
          ...product,
          workspaceId: normalizeWorkspaceId(workspaceId),
        },
        index,
      ),
    );

  entry.products = normalizedProducts;
  entry.productMap = new Map();
  normalizedProducts.forEach((product) => {
    entry.productMap.set(product.id, product);
    entry.productMap.set(product.sku, product);
    if (product.externalId) {
      entry.productMap.set(product.externalId, product);
    }
  });
  entry.categories = Array.isArray(input.categories) ? clone(input.categories) : [];
  entry.updatedAt = Date.now();
  entry.syncedAt = input.syncedAt || new Date().toISOString();

  return getCatalogCacheSnapshot(workspaceId);
}

function upsertCachedProduct(workspaceId, product) {
  const entry = ensureWorkspaceEntry(workspaceId);
  const normalized = normalizeCachedProduct(
    {
      ...product,
      workspaceId: normalizeWorkspaceId(workspaceId),
    },
    entry.products.length,
  );

  const nextProducts = entry.products.filter(
    (item) =>
      item.id !== normalized.id &&
      item.sku !== normalized.sku &&
      item.externalId !== normalized.externalId,
  );
  nextProducts.unshift(normalized);
  entry.products = nextProducts.slice(0, MAX_PRODUCTS_PER_WORKSPACE);
  entry.productMap = new Map();
  entry.products.forEach((item) => {
    entry.productMap.set(item.id, item);
    entry.productMap.set(item.sku, item);
    if (item.externalId) {
      entry.productMap.set(item.externalId, item);
    }
  });
  entry.updatedAt = Date.now();
  entry.syncedAt = new Date().toISOString();

  return clone(normalized);
}

function getCatalogCacheSnapshot(workspaceId) {
  const entry = ensureWorkspaceEntry(workspaceId);

  return {
    workspaceId: entry.workspaceId,
    syncedAt: entry.syncedAt,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    categories: clone(entry.categories),
    products: clone(entry.products),
  };
}

function listCachedProducts(params = {}) {
  const snapshot = getCatalogCacheSnapshot(params.workspaceId);
  const search = String(params.search || "").trim().toLowerCase();
  const status = normalizeStatus(params.status || "");
  const hasStatus = Boolean(String(params.status || "").trim());
  const stockState = String(params.stockState || "").trim().toLowerCase();
  const priceMin = params.priceMin == null || params.priceMin === "" ? null : toNumber(params.priceMin);
  const priceMax = params.priceMax == null || params.priceMax === "" ? null : toNumber(params.priceMax);
  const sort = normalizeSort(params.sort);
  const limit = Math.max(1, Number.parseInt(String(params.limit || 20), 10) || 20);
  const offset = Math.max(0, Number.parseInt(String(params.offset || 0), 10) || 0);

  let items = snapshot.products;

  if (search) {
    items = items.filter((product) =>
      [product.title, product.sku, product.ean]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search)),
    );
  }

  if (hasStatus) {
    items = items.filter((product) => normalizeStatus(product.status) === status);
  }

  if (stockState === "in_stock") {
    items = items.filter((product) => Number(product.stock || 0) > 0);
  } else if (stockState === "out_of_stock") {
    items = items.filter((product) => Number(product.stock || 0) <= 0);
  } else if (stockState === "low_stock") {
    items = items.filter((product) => Number(product.stock || 0) > 0 && Number(product.stock || 0) <= 5);
  }

  if (priceMin != null) {
    items = items.filter((product) => Number(product.currentPrice || 0) >= priceMin);
  }

  if (priceMax != null) {
    items = items.filter((product) => Number(product.currentPrice || 0) <= priceMax);
  }

  const compareMap = {
    updated_desc: (left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0),
    updated_asc: (left, right) => new Date(left.updatedAt || 0) - new Date(right.updatedAt || 0),
    title_asc: (left, right) => String(left.title || "").localeCompare(String(right.title || ""), "pt-BR"),
    title_desc: (left, right) => String(right.title || "").localeCompare(String(left.title || ""), "pt-BR"),
    price_desc: (left, right) => Number(right.currentPrice || 0) - Number(left.currentPrice || 0),
    price_asc: (left, right) => Number(left.currentPrice || 0) - Number(right.currentPrice || 0),
    stock_desc: (left, right) => Number(right.stock || 0) - Number(left.stock || 0),
    stock_asc: (left, right) => Number(left.stock || 0) - Number(right.stock || 0),
    revenue_desc: (left, right) => Number(right.revenueAmount || 0) - Number(left.revenueAmount || 0),
    revenue_asc: (left, right) => Number(left.revenueAmount || 0) - Number(right.revenueAmount || 0),
  };

  items = [...items].sort(compareMap[sort]);

  const paged = items.slice(offset, offset + limit);

  return {
    workspaceId: snapshot.workspaceId,
    syncedAt: snapshot.syncedAt,
    total: items.length,
    limit,
    offset,
    items: clone(paged),
  };
}

function getCachedProduct(workspaceId, identifier) {
  const entry = ensureWorkspaceEntry(workspaceId);
  const normalized = String(identifier || "").trim();
  if (!normalized) return null;

  const product = entry.productMap.get(normalized) || null;
  return product ? clone(product) : null;
}

function getCachedCatalogOverview(workspaceId) {
  const snapshot = getCatalogCacheSnapshot(workspaceId);
  const products = snapshot.products;
  const byStatusMap = new Map();
  const categoriesMap = new Map();

  products.forEach((product) => {
    const status = normalizeStatus(product.status);
    byStatusMap.set(status, (byStatusMap.get(status) || 0) + 1);
    const categoryName = product.categoryName || "Sem categoria";
    categoriesMap.set(categoryName, (categoriesMap.get(categoryName) || 0) + 1);
  });

  const totalProducts = products.length;
  const publishedProducts = products.filter((product) => normalizeStatus(product.status) === "published").length;
  const outOfStockProducts = products.filter((product) => Number(product.stock || 0) <= 0).length;
  const averagePrice = totalProducts
    ? products.reduce((total, product) => total + toNumber(product.currentPrice), 0) / totalProducts
    : 0;

  return {
    workspaceId: snapshot.workspaceId,
    syncedAt: snapshot.syncedAt,
    summary: {
      totalProducts,
      publishedProducts,
      outOfStockProducts,
      averagePrice: Number(averagePrice.toFixed(2)),
      recentlyUpdatedProducts: totalProducts,
    },
    byStatus: Array.from(byStatusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => right.count - left.count),
    topCategories: Array.from(categoriesMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 5),
  };
}

function getCachedCatalogMetrics(workspaceId) {
  const overview = getCachedCatalogOverview(workspaceId);

  return {
    products: overview.summary.totalProducts,
    publishedProducts: overview.summary.publishedProducts,
    outOfStockProducts: overview.summary.outOfStockProducts,
    syncedAt: overview.syncedAt,
  };
}

module.exports = {
  getCachedCatalogMetrics,
  getCachedCatalogOverview,
  getCachedProduct,
  getCatalogCacheSnapshot,
  listCachedProducts,
  storeCatalogSnapshot,
  upsertCachedProduct,
};
