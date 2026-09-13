const { resolveShop } = require("../utils/resolveShop");
const ShopeeFlashSaleService = require("../services/ShopeeFlashSaleService");
const {
  listActivePriceLocksByItemIds,
} = require("../repositories/priceIncreaseSqlRepository");
const { formatRemainingFromLock } = require("../services/priceIncreasePolicyService");

function toInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function toUnix(value) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function mapFlashSaleStatus(value) {
  const code = Number(value);
  return (
    {
      0: "deleted",
      1: "enabled",
      2: "disabled",
      3: "system_rejected",
    }[code] || "unknown"
  );
}

function mapFlashSaleType(value) {
  const code = Number(value);
  return (
    {
      1: "upcoming",
      2: "ongoing",
      3: "expired",
    }[code] || "all"
  );
}

function mapItemStatus(value) {
  const code = Number(value);
  return (
    {
      0: "disabled",
      1: "enabled",
      2: "deleted",
      4: "system_rejected",
      5: "manual_rejected",
    }[code] || "unknown"
  );
}

function mapCampaign(flashSale) {
  return {
    ...flashSale,
    statusLabel: mapFlashSaleStatus(flashSale?.status),
    typeLabel: mapFlashSaleType(flashSale?.type),
  };
}

function normalizeItemsPayload(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      const normalized = {
        item_id: Number(item.item_id ?? item.itemId),
      };

      if (item.purchase_limit !== undefined || item.purchaseLimit !== undefined) {
        normalized.purchase_limit = Number(
          item.purchase_limit ?? item.purchaseLimit,
        );
      }

      if (item.item_status !== undefined || item.itemStatus !== undefined) {
        normalized.item_status = Number(item.item_status ?? item.itemStatus);
      }

      if (
        item.item_input_promo_price !== undefined ||
        item.itemInputPromoPrice !== undefined
      ) {
        normalized.item_input_promo_price = Number(
          item.item_input_promo_price ?? item.itemInputPromoPrice,
        );
      }

      if (item.item_stock !== undefined || item.itemStock !== undefined) {
        normalized.item_stock = Number(item.item_stock ?? item.itemStock);
      }

      const models = Array.isArray(item.models)
        ? item.models
            .map((model) => ({
              model_id: Number(model.model_id ?? model.modelId),
              ...(model.status !== undefined
                ? { status: Number(model.status) }
                : {}),
              ...(model.input_promo_price !== undefined ||
              model.inputPromoPrice !== undefined
                ? {
                    input_promo_price: Number(
                      model.input_promo_price ?? model.inputPromoPrice,
                    ),
                  }
                : {}),
              ...(model.stock !== undefined
                ? { stock: Number(model.stock) }
                : {}),
            }))
            .filter((model) => Number.isFinite(model.model_id))
        : [];

      if (
        item.item_input_promo_price === undefined &&
        item.itemInputPromoPrice === undefined &&
        item.item_stock === undefined &&
        item.itemStock === undefined &&
        item.item_status === undefined &&
        item.itemStatus === undefined &&
        item.purchase_limit === undefined &&
        item.purchaseLimit === undefined &&
        !models.length
      ) {
        return null;
      }

      if (
        item.item_input_promo_price !== undefined ||
        item.itemInputPromoPrice !== undefined
      ) {
        normalized.item_input_promo_price = Number(
          item.item_input_promo_price ?? item.itemInputPromoPrice,
        );
      }

      if (item.item_stock !== undefined || item.itemStock !== undefined) {
        normalized.item_stock = Number(item.item_stock ?? item.itemStock);
      }

      if (models.length) normalized.models = models;

      return Number.isFinite(normalized.item_id) ? normalized : null;
    })
    .filter(Boolean);
}

async function getFlashSaleBlockedItems(shopDbId, items = []) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => {
      const itemId = Number(item?.item_id ?? item?.itemId);
      if (!Number.isFinite(itemId)) return null;
      const models = Array.isArray(item?.models)
        ? item.models
            .map((model) => Number(model?.model_id ?? model?.modelId))
            .filter((value) => Number.isFinite(value))
        : [];
      return {
        itemId: String(Math.trunc(itemId)),
        models,
      };
    })
    .filter(Boolean);

  if (!normalized.length) return [];

  const lockMap = await listActivePriceLocksByItemIds(
    shopDbId,
    normalized.map((item) => item.itemId),
    new Date(),
  );
  const now = new Date();

  return normalized
    .map((item) => {
      const lockEntry = lockMap.get(item.itemId);
      if (!lockEntry) return null;
      const remaining = formatRemainingFromLock(
        lockEntry.lockUntil ? new Date(lockEntry.lockUntil) : null,
        now,
      );
      if (!remaining.isBlocked) return null;
      return {
        itemId: item.itemId,
        modelIds: item.models.map((value) => String(value)),
        lockUntil: lockEntry.lockUntil || null,
        remainingLabel: remaining.remainingLabel,
      };
    })
    .filter(Boolean);
}

function buildFlashSaleLockMessage(blockedRows = []) {
  if (!blockedRows.length) return "";
  const firstRows = blockedRows.slice(0, 6);
  const details = firstRows
    .map((row) => `Item ${row.itemId} (${row.remainingLabel})`)
    .join("; ");
  const suffix =
    blockedRows.length > firstRows.length
      ? `; +${blockedRows.length - firstRows.length} item(ns)`
      : "";
  return `Produtos com aumento recente de preco estao bloqueados para Flash Sale por 7 dias: ${details}${suffix}.`;
}

function mergeFlashSaleItems(response) {
  const itemInfo = Array.isArray(response?.item_info) ? response.item_info : [];
  const models = Array.isArray(response?.models) ? response.models : [];
  const itemMap = new Map(
    itemInfo.map((item) => [String(item.item_id), item]),
  );

  const modelRows = models.map((model) => {
    const item = itemMap.get(String(model.item_id)) || null;
    return {
      kind: "model",
      itemId: String(model.item_id),
      itemName: item?.item_name || `Item ${model.item_id}`,
      itemImage: item?.image || null,
      productStatus: item?.status ?? null,
      modelId: String(model.model_id),
      modelName: model.model_name || `Modelo ${model.model_id}`,
      flashSaleStatus: model.status ?? null,
      flashSaleStatusLabel: mapItemStatus(model.status),
      originalPrice: model.original_price ?? null,
      inputPromotionPrice: model.input_promotion_price ?? null,
      promotionPriceWithTax: model.promotion_price_with_tax ?? null,
      purchaseLimit: model.purchase_limit ?? 0,
      campaignStock: model.campaign_stock ?? null,
      stock: model.stock ?? null,
      rejectReason: model.reject_reason || null,
      unqualifiedConditions: model.unqualified_conditions || [],
    };
  });

  const standaloneItems = itemInfo
    .filter((item) => !models.some((model) => String(model.item_id) === String(item.item_id)))
    .map((item) => ({
      kind: "item",
      itemId: String(item.item_id),
      itemName: item.item_name || `Item ${item.item_id}`,
      itemImage: item.image || null,
      productStatus: item.status ?? null,
      modelId: null,
      modelName: null,
      flashSaleStatus: item.item_status ?? null,
      flashSaleStatusLabel: mapItemStatus(item.item_status),
      originalPrice: item.original_price ?? null,
      inputPromotionPrice: item.input_promotion_price ?? null,
      promotionPriceWithTax: item.promotion_price_with_tax ?? null,
      purchaseLimit: item.purchase_limit ?? 0,
      campaignStock: item.campaign_stock ?? null,
      stock: item.stock ?? null,
      rejectReason: item.reject_reason || null,
      unqualifiedConditions: item.unqualified_conditions || [],
    }));

  return [...standaloneItems, ...modelRows];
}

function buildDuplicateFlashSaleItems(response) {
  const rows = mergeFlashSaleItems(response);
  const grouped = new Map();

  for (const row of rows) {
    const itemId = Number(row.itemId);
    if (!Number.isFinite(itemId)) continue;

    if (!grouped.has(itemId)) {
      grouped.set(itemId, {
        item_id: itemId,
        purchase_limit: Number(row.purchaseLimit || 0) || 0,
      });
    }

    const entry = grouped.get(itemId);
    entry.purchase_limit = Number(row.purchaseLimit || entry.purchase_limit || 0) || 0;

    if (row.kind === "model") {
      if (!Array.isArray(entry.models)) entry.models = [];
      entry.models.push({
        model_id: Number(row.modelId),
        input_promo_price: Number(row.inputPromotionPrice || 0),
        stock: Number(row.campaignStock || 0),
      });
      continue;
    }

    entry.item_input_promo_price = Number(row.inputPromotionPrice || 0);
    entry.item_stock = Number(row.campaignStock || 0);
  }

  return Array.from(grouped.values()).filter((item) => {
    if (Array.isArray(item.models) && item.models.length) return true;
    return (
      Number.isFinite(item.item_id) &&
      Number(item.item_input_promo_price || 0) > 0 &&
      Number(item.item_stock || 0) > 0
    );
  });
}

async function getShop(req) {
  const param = req.params.shopId || "active";
  return resolveShop(req, param);
}

async function getCriteria(req, res) {
  const shop = await getShop(req);
  const payload = await ShopeeFlashSaleService.getItemCriteria({
    shopId: String(shop.shopId),
  });

  return res.json({
    ok: true,
    criteria: payload?.response?.criteria || [],
    pairIds: payload?.response?.pair_ids || [],
    raw: payload?.response || {},
  });
}

async function getTimeSlots(req, res) {
  const shop = await getShop(req);
  const nowTs = Math.floor(Date.now() / 1000);
  const rawStartTime = toUnix(req.query.start_time ?? req.query.startTime);
  const startTime = rawStartTime ? Math.max(rawStartTime, nowTs) : null;
  const endTime = toUnix(req.query.end_time ?? req.query.endTime);

  if (!startTime || !endTime) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Informe start_time e end_time.",
    });
  }

  const payload = await ShopeeFlashSaleService.getTimeSlots({
    shopId: String(shop.shopId),
    startTime,
    endTime,
  });

  return res.json({
    ok: true,
    timeSlots: Array.isArray(payload?.response) ? payload.response : [],
  });
}

async function listFlashSales(req, res) {
  const shop = await getShop(req);
  const payload = await ShopeeFlashSaleService.getFlashSaleList({
    shopId: String(shop.shopId),
    type: toInt(req.query.type, 0),
    offset: toInt(req.query.offset, 0),
    limit: toInt(req.query.limit, 20),
    startTime: toUnix(req.query.start_time ?? req.query.startTime),
    endTime: toUnix(req.query.end_time ?? req.query.endTime),
  });

  const response = payload?.response || {};

  return res.json({
    ok: true,
    totalCount: response.total_count || 0,
    flashSales: (response.flash_sale_list || []).map(mapCampaign),
  });
}

async function createFlashSale(req, res) {
  const shop = await getShop(req);
  const timeslotId = toInt(req.body?.timeslot_id ?? req.body?.timeslotId);

  if (!timeslotId) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Informe timeslot_id.",
    });
  }

  const payload = await ShopeeFlashSaleService.createFlashSale({
    shopId: String(shop.shopId),
    timeslotId,
  });

  return res.json({
    ok: true,
    flashSale: mapCampaign(payload?.response || {}),
  });
}

async function getFlashSale(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const payload = await ShopeeFlashSaleService.getFlashSale({
    shopId: String(shop.shopId),
    flashSaleId,
  });

  return res.json({
    ok: true,
    flashSale: mapCampaign(payload?.response || {}),
  });
}

async function getFlashSaleItems(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const payload = await ShopeeFlashSaleService.getFlashSaleItems({
    shopId: String(shop.shopId),
    flashSaleId,
    offset: toInt(req.query.offset, 0),
    limit: toInt(req.query.limit, 100),
  });

  const response = payload?.response || {};

  return res.json({
    ok: true,
    totalCount: response.total_count || 0,
    itemInfo: response.item_info || [],
    models: response.models || [],
    rows: mergeFlashSaleItems(response),
  });
}

async function addItems(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const items = normalizeItemsPayload(req.body?.items);

  if (!items.length) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Nenhum item valido para adicionar.",
    });
  }

  const blockedRows = await getFlashSaleBlockedItems(shop.id, items);
  if (blockedRows.length) {
    return res.status(409).json({
      ok: false,
      error: "promotion_lock_active",
      message: buildFlashSaleLockMessage(blockedRows),
      blockedItems: blockedRows,
    });
  }

  const payload = await ShopeeFlashSaleService.addFlashSaleItems({
    shopId: String(shop.shopId),
    flashSaleId,
    items,
  });

  return res.json({
    ok: true,
    result: payload?.response || {},
  });
}

async function updateStatus(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const status = toInt(req.body?.status);

  if (![1, 2].includes(status)) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Status invalido. Use 1 para habilitar ou 2 para desabilitar.",
    });
  }

  const payload = await ShopeeFlashSaleService.updateFlashSale({
    shopId: String(shop.shopId),
    flashSaleId,
    status,
  });

  return res.json({
    ok: true,
    flashSale: mapCampaign(payload?.response || {}),
  });
}

async function updateItems(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const items = normalizeItemsPayload(req.body?.items);

  if (!items.length) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Nenhum item valido para atualizar.",
    });
  }

  const blockedRows = await getFlashSaleBlockedItems(shop.id, items);
  if (blockedRows.length) {
    return res.status(409).json({
      ok: false,
      error: "promotion_lock_active",
      message: buildFlashSaleLockMessage(blockedRows),
      blockedItems: blockedRows,
    });
  }

  const payload = await ShopeeFlashSaleService.updateFlashSaleItems({
    shopId: String(shop.shopId),
    flashSaleId,
    items,
  });

  return res.json({
    ok: true,
    result: payload?.response || {},
  });
}

async function deleteItems(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const itemIds = Array.isArray(req.body?.item_ids)
    ? req.body.item_ids
    : Array.isArray(req.body?.itemIds)
      ? req.body.itemIds
      : [];

  const normalized = itemIds
    .map((id) => toInt(id))
    .filter((id) => Number.isFinite(id));

  if (!normalized.length) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Nenhum item valido para excluir.",
    });
  }

  const payload = await ShopeeFlashSaleService.deleteFlashSaleItems({
    shopId: String(shop.shopId),
    flashSaleId,
    itemIds: normalized,
  });

  return res.json({
    ok: true,
    result: payload?.response || {},
  });
}

async function deleteFlashSale(req, res) {
  const shop = await getShop(req);
  const flashSaleId = toInt(req.params.flashSaleId);
  const payload = await ShopeeFlashSaleService.deleteFlashSale({
    shopId: String(shop.shopId),
    flashSaleId,
  });

  return res.json({
    ok: true,
    flashSale: mapCampaign(payload?.response || {}),
  });
}

async function duplicateFlashSale(req, res) {
  const shop = await getShop(req);
  const sourceFlashSaleId = toInt(req.params.flashSaleId);
  const timeslotId = toInt(req.body?.timeslot_id ?? req.body?.timeslotId);

  if (!sourceFlashSaleId || !timeslotId) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: "Informe flash_sale_id de origem e timeslot_id de destino.",
    });
  }

  const created = await ShopeeFlashSaleService.createFlashSale({
    shopId: String(shop.shopId),
    timeslotId,
  });

  const newFlashSale = created?.response || {};
  const newFlashSaleId = toInt(newFlashSale.flash_sale_id);

  if (!newFlashSaleId) {
    return res.status(502).json({
      ok: false,
      error: "creation_failed",
      message: "A Shopee nao retornou a nova flash sale criada.",
    });
  }

  const sourceItemsPayload = await ShopeeFlashSaleService.getFlashSaleItems({
    shopId: String(shop.shopId),
    flashSaleId: sourceFlashSaleId,
    offset: 0,
    limit: 100,
  });

  const items = buildDuplicateFlashSaleItems(sourceItemsPayload?.response || {});
  let addResult = null;

  if (items.length) {
    const blockedRows = await getFlashSaleBlockedItems(shop.id, items);
    if (blockedRows.length) {
      return res.status(409).json({
        ok: false,
        error: "promotion_lock_active",
        message: buildFlashSaleLockMessage(blockedRows),
        blockedItems: blockedRows,
      });
    }

    const addPayload = await ShopeeFlashSaleService.addFlashSaleItems({
      shopId: String(shop.shopId),
      flashSaleId: newFlashSaleId,
      items,
    });
    addResult = addPayload?.response || null;
  }

  return res.json({
    ok: true,
    flashSale: mapCampaign(newFlashSale),
    copiedItems: items.length,
    addResult,
  });
}

module.exports = {
  getCriteria,
  getTimeSlots,
  listFlashSales,
  createFlashSale,
  getFlashSale,
  getFlashSaleItems,
  addItems,
  updateStatus,
  updateItems,
  deleteItems,
  deleteFlashSale,
  duplicateFlashSale,
};
