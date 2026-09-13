"use strict";

const {
  bumpProductSyncRun,
  findShopByShopeeShopId,
  listExistingProductRatings,
  replaceProductImages,
  replaceProductModels,
  upsertProductForSync,
  upsertProductModelsForSync,
} = require("../repositories/productSyncSqlRepository");
const {
  upsertProductTrafficDailySnapshots,
} = require("../repositories/productTrafficSqlRepository");
const ShopeeProductService = require("./ShopeeProductService");
const { getItemRatingSummary } = require("./ShopeeProductCommentService");
const {
  extractLogistics,
  buildSpxSnapshot,
} = require("../utils/productLogistics");

function readPositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapLimit(list, limit, fn) {
  const ret = [];
  const executing = new Set();

  for (const item of list) {
    const promise = Promise.resolve().then(() => fn(item));
    ret.push(promise);
    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(ret);
}

function toBigInt(value) {
  return BigInt(String(value));
}

function asItemIdStr(value) {
  return String(value ?? "").trim();
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickNumberFromKeys(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (source[key] == null || source[key] === "") continue;
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function extractTrafficRowsFromExtraInfoResponse(response) {
  const root =
    response?.response && typeof response.response === "object"
      ? response.response
      : response;
  const itemList = [
    ...(Array.isArray(root?.item_list) ? root.item_list : []),
    ...(Array.isArray(root?.item_extra_info_list)
      ? root.item_extra_info_list
      : []),
  ];

  return itemList
    .map((row) => {
      const itemId = asItemIdStr(row?.item_id || row?.itemId);
      if (!/^\d+$/.test(itemId)) return null;

      const impressions = Math.max(
        0,
        toNumberOrZero(
          row?.views ??
            pickNumberFromKeys(row, [
              "view",
              "views",
              "impression",
              "impressions",
            ]),
        ),
      );
      const visitsRaw = pickNumberFromKeys(row, [
        "visit",
        "visits",
        "visitor",
        "visitors",
        "uv",
        "unique_visitor",
        "unique_visitors",
      ]);

      return {
        itemId,
        impressionsCumulative: impressions,
        visitsCumulative: Math.max(
          0,
          toNumberOrZero(visitsRaw != null ? visitsRaw : impressions),
        ),
        source: "product_sync_cycle_10",
      };
    })
    .filter(Boolean);
}

async function syncTrafficSnapshotsForBatch({
  shopRow,
  shopeeShopId,
  itemIds,
}) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((itemId) => asItemIdStr(itemId))
        .filter((itemId) => /^\d+$/.test(itemId)),
    ),
  );
  if (!normalizedIds.length) {
    return { persisted: 0, failed: 0 };
  }

  const rows = [];
  let failed = 0;
  for (const batch of chunk(normalizedIds, 50)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getItemExtraInfoBatch({
        shopId: shopeeShopId,
        itemIdList: batch,
      });
      rows.push(...extractTrafficRowsFromExtraInfoResponse(response));
    } catch (_error) {
      failed += batch.length;
    }
  }

  if (!rows.length) {
    return { persisted: 0, failed };
  }

  const persistedRows = await upsertProductTrafficDailySnapshots(
    shopRow.id,
    new Date(),
    rows,
  );

  return {
    persisted: Array.isArray(persistedRows) ? persistedRows.length : 0,
    failed,
  };
}

async function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    await Promise.resolve(onProgress(payload));
  } catch (_error) {
    // Progresso nunca deve interromper o sync.
  }
}

function mapModelPayload(modelList = []) {
  return (Array.isArray(modelList) ? modelList : []).map((model) => ({
    modelId: model.model_id,
    name: model.model_name || null,
    sku: model.sku || null,
    gtinCode: model.gtin_code || model.gtin || null,
    price: model.price_info?.[0]?.current_price ?? null,
    stock: model.stock_info_v2?.summary_info?.total_available_stock ?? null,
    sold: model.sold ?? null,
  }));
}

async function syncProductsForShop({
  shopeeShopId,
  pageSize = 50,
  onProgress,
} = {}) {
  const shopRow = await findShopByShopeeShopId(shopeeShopId);

  if (!shopRow) {
    const err = new Error("Shop nao cadastrado no banco");
    err.statusCode = 400;
    throw err;
  }

  const MODEL_CONCURRENCY = readPositiveIntEnv("MODEL_FETCH_CONCURRENCY", 6);
  const COMMENT_CONCURRENCY = readPositiveIntEnv("COMMENT_FETCH_CONCURRENCY", 4);
  const RATING_SYNC_EVERY_RUNS = readPositiveIntEnv(
    "PRODUCT_RATING_SYNC_EVERY_RUNS",
    10,
  );
  const STOCK_SYNC_EVERY_RUNS = readPositiveIntEnv(
    "PRODUCT_STOCK_SYNC_EVERY_RUNS",
    5,
  );
  const ITEM_STATUSES_TO_SYNC = ["NORMAL", "UNLIST"];

  const syncState = await bumpProductSyncRun(shopRow.id);
  const runCount = Math.max(1, Number(syncState.runCount || 1));
  const shouldRefreshRatings = runCount % RATING_SYNC_EVERY_RUNS === 0;
  const shouldRefreshTraffic = shouldRefreshRatings;
  const shouldRefreshStock = runCount % STOCK_SYNC_EVERY_RUNS === 0;
  const syncedItemIds = new Set();

  let fetched = 0;
  let upserted = 0;
  let pricesPreserved = 0;
  let stockPreserved = 0;
  let imagesCreated = 0;
  let imagesSkipped = 0;
  let ratingsRefreshed = 0;
  let ratingsSkipped = 0;
  let trafficSnapshots = 0;
  let trafficFailed = 0;
  let modelsFetched = 0;
  let modelsUpdated = 0;
  let modelsSkipped = 0;
  let modelsFailed = 0;

  await emitProgress(onProgress, {
    phase: "started",
    percent: 1,
    runCount,
    shouldRefreshRatings,
    shouldRefreshTraffic,
    shouldRefreshStock,
    message: "Preparando sincronizacao leve de produtos...",
  });

  for (const itemStatus of ITEM_STATUSES_TO_SYNC) {
    let offset = 0;
    let hasNext = true;

    while (hasNext) {
      const list = await ShopeeProductService.getItemList({
        shopId: shopeeShopId,
        offset,
        pageSize,
        itemStatus,
      });

      const items = list?.response?.item || [];
      const itemIds = items
        .map((entry) => entry.item_id)
        .filter(Boolean)
        .filter((itemId) => {
          const itemIdStr = asItemIdStr(itemId);
          if (!itemIdStr || syncedItemIds.has(itemIdStr)) return false;
          syncedItemIds.add(itemIdStr);
          return true;
        });
      fetched += itemIds.length;

      await emitProgress(onProgress, {
        phase: "listed",
        percent: Math.min(92, 5 + Math.floor(fetched / 8)),
        itemStatus,
        fetched,
        upserted,
        message: `IDs localizados: ${fetched}. Atualizados: ${upserted}.`,
      });

      if (!itemIds.length) {
        hasNext = Boolean(list?.response?.has_next_page);
        offset = Number(list?.response?.next_offset || 0);
        if (!hasNext) break;
        continue;
      }

      for (const batch of chunk(itemIds, 20)) {
        const details = await ShopeeProductService.getItemBaseInfo({
          shopId: shopeeShopId,
          itemIdList: batch,
          needTaxInfo: false,
        });

        const baseList = details?.response?.item_list || [];
        if (!baseList.length) {
          continue;
        }

        const existingRows = await listExistingProductRatings(
          shopRow.id,
          baseList.map((product) => product?.item_id).filter(Boolean),
        );
        const existingByItemId = new Map();
        for (const row of existingRows) {
          existingByItemId.set(String(row.itemId), row);
        }

        let ratingResults = [];
        if (shouldRefreshRatings) {
          ratingResults = await mapLimit(
            baseList,
            COMMENT_CONCURRENCY,
            async (product) => {
              if (!product?.item_id) return null;

              const itemIdStr = asItemIdStr(product.item_id);
              const rating = await getItemRatingSummary({
                shopId: String(shopeeShopId),
                itemId: itemIdStr,
                max: 500,
                pageSize: 100,
              });

              return {
                itemId: itemIdStr,
                ok: true,
                avgStar: Number.isFinite(rating.avgStar) ? rating.avgStar : 0,
                ratingCount: Number.isInteger(rating.ratingCount)
                  ? rating.ratingCount
                  : 0,
                over500: Boolean(rating.over500),
              };
            },
          );
        } else {
          ratingsSkipped += baseList.length;
        }

        const ratingByItemId = new Map();
        const ratingComputedNow = new Set();
        for (const result of ratingResults) {
          if (result.status === "fulfilled" && result.value?.itemId && result.value?.ok) {
            ratingByItemId.set(result.value.itemId, result.value);
            ratingComputedNow.add(result.value.itemId);
            ratingsRefreshed += 1;
          }
        }

        if (shouldRefreshTraffic) {
          const trafficResult = await syncTrafficSnapshotsForBatch({
            shopRow,
            shopeeShopId,
            itemIds: baseList.map((product) => product?.item_id).filter(Boolean),
          });
          trafficSnapshots += trafficResult.persisted;
          trafficFailed += trafficResult.failed;
        }

        const withModel = baseList.filter((product) => {
          if (!product?.has_model || !product?.item_id) return false;
          const existing = existingByItemId.get(asItemIdStr(product.item_id));
          return shouldRefreshStock || !existing?.id;
        });
        const modelResults = await mapLimit(
          withModel,
          MODEL_CONCURRENCY,
          async (product) => {
            const itemId = String(product.item_id);
            try {
              const response = await ShopeeProductService.getModelList({
                shopId: shopeeShopId,
                itemId: product.item_id,
              });

              return {
                itemId,
                failed: false,
                models: response?.response?.model || [],
              };
            } catch (_error) {
              return {
                itemId,
                failed: true,
                models: [],
              };
            }
          },
        );
        modelsFetched += withModel.length;

        const modelsByItemId = new Map();
        for (const result of modelResults) {
          if (result.status === "fulfilled" && result.value?.itemId) {
            modelsByItemId.set(result.value.itemId, result.value);
          }
        }

        for (const product of baseList) {
          if (!product?.item_id) {
            continue;
          }

          const itemIdStr = asItemIdStr(product.item_id);
          const existing = existingByItemId.get(itemIdStr) || null;
          const isNewProduct = !existing?.id;
          const productLogistics = extractLogistics(product.logistic_info);
          const spxSnapshot = buildSpxSnapshot({
            logistics: productLogistics,
            dimension: product.dimension ?? null,
            weight: product.weight != null ? Number(product.weight) : null,
          });

          const ratingResult = ratingByItemId.get(itemIdStr) || null;
          const ratingStarFinal =
            ratingResult && ratingResult.avgStar !== null
              ? ratingResult.avgStar
              : existing?.ratingStar ?? product.rating?.rating_star ?? null;
          const ratingCountFinal =
            ratingResult && ratingResult.ratingCount !== null
              ? ratingResult.ratingCount
              : existing?.ratingCount ?? product.rating?.rating_count ?? null;
          const ratingOver500Final = ratingResult
            ? Boolean(ratingResult.over500)
            : Boolean(existing?.ratingOver500 ?? false);
          const shouldUpdateRatingSyncedAt = ratingComputedNow.has(itemIdStr);
          const shouldUpdatePrice = isNewProduct;
          const shouldUpdateStock = isNewProduct || shouldRefreshStock;

          if (!shouldUpdatePrice) pricesPreserved += 1;
          if (!shouldUpdateStock) stockPreserved += 1;

          const savedProduct = await upsertProductForSync(shopRow.id, {
            itemId: product.item_id,
            status: product.item_status || null,
            title: product.item_name || null,
            description: product.description || null,
            attributes: product.attribute_list ?? null,
            logistics: productLogistics.length ? productLogistics : null,
            dimension: product.dimension ?? null,
            weight: product.weight != null ? Number(product.weight) : null,
            shippingModeCache: spxSnapshot.cache.shippingModeCache,
            spxEnabledCache: spxSnapshot.cache.spxEnabledCache,
            spxLogisticsEligibleCache: spxSnapshot.cache.spxLogisticsEligibleCache,
            spxPhysicalEligibleCache: spxSnapshot.cache.spxPhysicalEligibleCache,
            spxEligibleCache: spxSnapshot.cache.spxEligibleCache,
            spxEligibilityReasonsCache: spxSnapshot.cache.spxEligibilityReasonsCache,
            spxSnapshotAt: spxSnapshot.cache.spxSnapshotAt,
            daysToShip: product.pre_order?.days_to_ship ?? null,
            itemSku: product.item_sku || null,
            gtinCode: product.gtin_code || null,
            brand: product.brand?.original_brand_name || null,
            currency: product.currency || null,
            priceMin: product.price_info?.[0]?.current_price ?? null,
            priceMax: product.price_info?.[0]?.current_price ?? null,
            stock: product.stock_info_v2?.summary_info?.total_available_stock ?? null,
            sold: product.sold ?? null,
            ratingStar: ratingStarFinal,
            ratingCount: ratingCountFinal,
            ratingOver500: ratingOver500Final,
            ratingSyncedAt: shouldUpdateRatingSyncedAt ? new Date() : null,
            shouldUpdateRatingSyncedAt,
            shouldUpdatePrice,
            shouldUpdateStock,
            shouldUpdateSold: true,
            hasModel: product.has_model ?? null,
            categoryId: product.category_id ? toBigInt(product.category_id) : null,
            shopeeCreateTime: product.create_time
              ? new Date(Number(product.create_time) * 1000)
              : null,
            shopeeUpdateTime: product.update_time
              ? new Date(Number(product.update_time) * 1000)
              : null,
          });

          upserted += 1;

          if (Array.isArray(product.image?.image_url_list)) {
            if (isNewProduct) {
              await replaceProductImages(savedProduct.id, product.image.image_url_list);
              imagesCreated += 1;
            } else {
              imagesSkipped += 1;
            }
          }

          if (product.has_model) {
            const modelSnapshot = modelsByItemId.get(itemIdStr) || null;
            if (modelSnapshot?.failed) {
              modelsFailed += 1;
              continue;
            }
            if (!modelSnapshot) {
              modelsSkipped += 1;
              continue;
            }

            const modelPayload = mapModelPayload(modelSnapshot.models);
            if (isNewProduct) {
              await replaceProductModels(savedProduct.id, modelPayload);
            } else {
              await upsertProductModelsForSync(savedProduct.id, modelPayload, {
                shouldUpdatePrice: false,
                shouldUpdateStock,
                shouldUpdateSold: true,
              });
            }
            modelsUpdated += 1;
          } else if (isNewProduct) {
            await replaceProductModels(savedProduct.id, []);
          }
        }

        await emitProgress(onProgress, {
          phase: "upserting",
          percent: Math.min(96, 10 + Math.floor(upserted / 6)),
          itemStatus,
          fetched,
          upserted,
          pricesPreserved,
          stockPreserved,
          imagesCreated,
          imagesSkipped,
          message: `Produtos atualizados: ${upserted}. Precos preservados: ${pricesPreserved}.`,
        });
      }

      hasNext = Boolean(list?.response?.has_next_page);
      offset = Number(list?.response?.next_offset || 0);
      if (!hasNext) break;
    }
  }

  const summary = {
    fetched,
    upserted,
    runCount,
    priceSource: "item_price_update_push",
    pricesPreserved,
    stockPreserved,
    imagesCreated,
    imagesSkipped,
    ratingsRefreshed,
    ratingsSkipped,
    trafficSnapshots,
    trafficFailed,
    modelsFetched,
    modelsUpdated,
    modelsSkipped,
    modelsFailed,
    cycles: {
      stockEveryRuns: STOCK_SYNC_EVERY_RUNS,
      stockRefreshed: shouldRefreshStock,
      ratingsEveryRuns: RATING_SYNC_EVERY_RUNS,
      ratingsRefreshed: shouldRefreshRatings,
      trafficEveryRuns: RATING_SYNC_EVERY_RUNS,
      trafficRefreshed: shouldRefreshTraffic,
    },
  };

  await emitProgress(onProgress, {
    phase: "done",
    percent: 100,
    ...summary,
    message: "Sincronizacao de produtos concluida.",
  });

  return {
    status: "ok",
    shop_id: String(shopeeShopId),
    summary,
  };
}

module.exports = { syncProductsForShop };
