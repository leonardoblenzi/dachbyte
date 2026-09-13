"use strict";

const {
  findShopByDbIdAndAccountId,
} = require("../repositories/operationsSqlRepository");
const {
  listActivePriceLocksByItemIds,
  listRecentPriceUpdateEvents,
  getPriceIncreaseDashboardSummary,
} = require("../repositories/priceIncreaseSqlRepository");
const { formatRemainingFromLock } = require("../services/priceIncreasePolicyService");

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

  const shop = await findShopByDbIdAndAccountId(shopDbId, req.auth.accountId);
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

function parseItemIdsFromQuery(rawValue) {
  return Array.from(
    new Set(
      String(rawValue || "")
        .split(",")
        .map((token) => String(token || "").trim())
        .filter((token) => /^\d+$/.test(token)),
    ),
  );
}

function mapEventWithRemaining(event, now = new Date()) {
  const lockUntilDate = event?.lockUntil ? new Date(event.lockUntil) : null;
  const remaining = formatRemainingFromLock(lockUntilDate, now);
  return {
    id: event.id,
    itemId: event.itemId == null ? null : String(event.itemId),
    modelId: event.modelId == null ? null : String(event.modelId),
    title: event.productTitle || "Produto",
    itemSku: event.itemSku || null,
    updateField: event.updateField,
    oldValue: event.oldValue,
    newValue: event.newValue,
    updateTime: event.updateTime,
    pushTimestamp: event.pushTimestamp,
    lockUntil: event.lockUntil,
    isBlockedForPromotion: event.isBlockedForPromotion,
    isBlockedNow: remaining.isBlocked,
    remainingMs: remaining.remainingMs,
    remainingLabel: remaining.remainingLabel,
  };
}

async function listActiveLocks(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const itemIds = parseItemIdsFromQuery(req.query?.itemIds || req.query?.items);
  const lockMap = await listActivePriceLocksByItemIds(shop.id, itemIds, new Date());

  const locks = Array.from(lockMap.values()).map((entry) => {
    const lockUntilDate = entry?.lockUntil ? new Date(entry.lockUntil) : null;
    const remaining = formatRemainingFromLock(lockUntilDate, new Date());
    return {
      itemId: entry.itemId == null ? null : String(entry.itemId),
      lockUntil: entry.lockUntil,
      updateTime: entry.updateTime,
      lockCount: entry.lockCount,
      isBlockedNow: remaining.isBlocked,
      remainingMs: remaining.remainingMs,
      remainingLabel: remaining.remainingLabel,
    };
  });

  return res.json({
    ok: true,
    total: locks.length,
    locks,
  });
}

async function dashboardOverview(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 12) || 12));
  const now = new Date();
  const [summary, recentResult] = await Promise.all([
    getPriceIncreaseDashboardSummary(shop.id, now),
    listRecentPriceUpdateEvents(shop.id, { onlyBlocked: false, limit }),
  ]);
  const events = Array.isArray(recentResult)
    ? recentResult
    : Array.isArray(recentResult?.items)
      ? recentResult.items
      : [];

  return res.json({
    ok: true,
    summary,
    items: events.map((event) => mapEventWithRemaining(event, now)),
  });
}

async function listRecent(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const onlyBlocked =
    String(req.query?.onlyBlocked || "").trim().toLowerCase() === "1" ||
    String(req.query?.onlyBlocked || "").trim().toLowerCase() === "true";
  const requestedPageSize = Number(req.query?.pageSize || req.query?.limit || 100) || 100;
  const pageSize = Math.max(1, Math.min(500, requestedPageSize));
  const page = Math.max(1, Number(req.query?.page || 1) || 1);
  const offset = Math.max(0, (page - 1) * pageSize);
  const search = String(req.query?.q || req.query?.search || "").trim();
  const now = new Date();
  const result = await listRecentPriceUpdateEvents(shop.id, {
    onlyBlocked,
    limit: pageSize,
    offset,
    search,
  });
  const events = Array.isArray(result) ? result : result.items || [];
  const total = Array.isArray(result) ? result.length : Number(result.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return res.json({
    ok: true,
    total,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    items: events.map((event) => mapEventWithRemaining(event, now)),
  });
}

module.exports = {
  listActiveLocks,
  dashboardOverview,
  listRecent,
};
