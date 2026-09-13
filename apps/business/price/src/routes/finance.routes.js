"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete, requireCsrf } = require("../auth");
const { requirePermission } = require("../permissions");
const meli = require("../integrations/mercadoLivre");
const shopee = require("../integrations/shopee");
const { withTenant } = require("../db");
const { resolveMeliConnectionForOrder } = require("../orders/meliAccount");
const { resolveShopeeConnectionForOrder } = require("../orders/shopeeAccount");
const { cachedFee, saveFeeSnapshot, calculateOrderProfit, profitOverview } = require("../finance/service");
const { cashOverview, createEntries, settleEntry, cancelEntry, createReference, createRecurrence, materializeRecurrence, createMarketplaceReceivable } = require("../finance/cashService");

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

function isInternalOrderId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function createFeeResponse({
  resolveMeliConnectionForOrderFn = resolveMeliConnectionForOrder,
  resolveShopeeConnectionForOrderFn = resolveShopeeConnectionForOrder,
  cachedFeeFn = cachedFee,
  saveFeeSnapshotFn = saveFeeSnapshot,
  meliOrderFees = meli.orderFees,
  shopeeOrderFees = shopee.orderFees,
} = {}) {
  return async function feeResponse(req, res, next, channel) {
    try {
      const orderId = String(req.params.orderId);
      if (channel === "shopee" && !isInternalOrderId(orderId)) {
        throw Object.assign(new Error("ID interno do pedido Shopee invalido."), { statusCode: 400, code: "shopee_order_id_invalid" });
      }
      const maxAge = channel === "meli" ? 12 : 6;
      const resolved = channel === "meli"
        ? await resolveMeliConnectionForOrderFn(req.vpAuth, orderId)
        : await resolveShopeeConnectionForOrderFn(req.vpAuth, orderId);
      const externalOrderId = String(resolved.order.marketplace_order_id);
      const connectionId = resolved.connection.id;
      const cached = !req.body?.force && await cachedFeeFn(req.vpAuth, channel, externalOrderId, maxAge, connectionId);
      if (cached) return res.json({ ...(cached.raw_data || {}), summary: cached.summary, financialSnapshot: cached, cache: { hit: true, fetchedAt: cached.fetched_at } });
      const result = channel === "meli"
        ? await meliOrderFees(req.vpAuth, externalOrderId, connectionId)
        : await shopeeOrderFees(req.vpAuth, externalOrderId, connectionId);
      const resultWithConnection = { ...result, connectionId };
      const saved = await saveFeeSnapshotFn(req.vpAuth, resultWithConnection);
      return res.json({ ...resultWithConnection, financialSnapshot: saved.snapshot, cache: { hit: false, unchanged: !saved.created } });
    } catch (error) { return next(error); }
  };
}

const feeResponse = createFeeResponse();
router.post("/orders/fees/meli/:orderId", requireCsrf, requirePermission("fees.read"), (req, res, next) => feeResponse(req, res, next, "meli"));
router.post("/orders/fees/shopee/:orderId", requireCsrf, requirePermission("fees.read"), (req, res, next) => feeResponse(req, res, next, "shopee"));

router.get("/orders/fees/history/:channel/:orderId", requirePermission("fees.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (await client.query(
      `SELECT id,channel,external_order_id,version,currency,components,total_amount,source_updated_at,is_current,fetched_at
       FROM volt_price.fee_snapshots WHERE channel=$1 AND external_order_id=$2 ORDER BY version DESC,fetched_at DESC`,
      [req.params.channel, req.params.orderId],
    )).rows);
    res.json({ snapshots: rows });
  } catch (error) { next(error); }
});

router.get("/profit", requirePermission("profit.read"), async (req, res, next) => {
  try { res.json(await profitOverview(req.vpAuth)); } catch (error) { next(error); }
});

router.post("/profit/order/:orderId/calculate", requireCsrf, requirePermission("profit.manage"), async (req, res, next) => {
  try { res.status(201).json(await calculateOrderProfit(req.vpAuth, req.params.orderId, req.body || {}, req)); } catch (error) { next(error); }
});

router.get("/cash", requirePermission("cash.read"), async (req, res, next) => {
  try { res.json(await cashOverview(req.vpAuth, req.query || {})); } catch (error) { next(error); }
});

router.post("/cash", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json({ entries: await createEntries(req.vpAuth, req.body || {}, req) }); } catch (error) { next(error); }
});

router.post("/cash/:id/settlements", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json(await settleEntry(req.vpAuth, req.params.id, req.body || {}, req)); } catch (error) { next(error); }
});

router.delete("/cash/:id", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.json({ entry: await cancelEntry(req.vpAuth, req.params.id, req) }); } catch (error) { next(error); }
});

router.post("/cash/accounts", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json({ account: await createReference(req.vpAuth, "account", req.body || {}, req) }); } catch (error) { next(error); }
});

router.post("/cash/categories", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json({ category: await createReference(req.vpAuth, "category", req.body || {}, req) }); } catch (error) { next(error); }
});

router.post("/cash/cost-centers", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json({ costCenter: await createReference(req.vpAuth, "costCenter", req.body || {}, req) }); } catch (error) { next(error); }
});

router.post("/cash/recurrences", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try {
    const recurrence = await createRecurrence(req.vpAuth, req.body || {}, req);
    const materialized = await materializeRecurrence(req.vpAuth, recurrence.id, req.body?.throughDate, req);
    res.status(201).json({ recurrence, materialized });
  } catch (error) { next(error); }
});

router.post("/cash/recurrences/:id/materialize", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.json(await materializeRecurrence(req.vpAuth, req.params.id, req.body?.throughDate, req)); } catch (error) { next(error); }
});

router.post("/cash/receivables", requireCsrf, requirePermission("cash.manage"), async (req, res, next) => {
  try { res.status(201).json(await createMarketplaceReceivable(req.vpAuth, req.body || {}, req)); } catch (error) { next(error); }
});

module.exports = { financeRouter: router, createFeeResponse, isInternalOrderId };
