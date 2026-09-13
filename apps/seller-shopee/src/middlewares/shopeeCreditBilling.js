"use strict";

const crypto = require("crypto");
const { resolveShop } = require("../utils/resolveShop");
const {
  reserveShopCredits,
  settleShopCredits,
  HubBillingError,
} = require("../services/hubResourceBillingService");
const {
  estimateShopeeOperationCredits,
} = require("../services/shopeeCreditCosts");

function idempotencyKey(operationKey, req) {
  const userId = req.auth?.userId == null ? "user" : String(req.auth.userId);
  const shopId = req.auth?.activeShopId == null ? "shop" : String(req.auth.activeShopId);
  return `shopee:${operationKey}:${userId}:${shopId}:${Date.now()}:${crypto.randomBytes(5).toString("hex")}`;
}

function requestPayload(req) {
  return {
    ...(req.query && typeof req.query === "object" ? req.query : {}),
    ...(req.params && typeof req.params === "object" ? req.params : {}),
    ...(req.body && typeof req.body === "object" ? req.body : {}),
    files: Array.isArray(req.files) ? req.files.map((file) => ({ size: file.size, fieldname: file.fieldname })) : undefined,
  };
}

function sendBillingError(res, error) {
  const statusCode = Number(error?.statusCode || error?.status || 402);
  return res.status(statusCode).json({
    ok: false,
    error: error?.code || "credit_billing_failed",
    message: error?.message || "Nao foi possivel validar os creditos desta operacao.",
    details: error?.details || null,
  });
}

function chargeOperation(operationKey, options = {}) {
  const normalizedOperation = String(operationKey || "").trim().toLowerCase();
  const estimate =
    typeof options.estimate === "function"
      ? options.estimate
      : (req) => estimateShopeeOperationCredits(normalizedOperation, requestPayload(req));

  return async function shopeeCreditBillingMiddleware(req, res, next) {
    let reservation = null;
    try {
      const shop = await resolveShop(req, req.params?.shopId || "active");
      if (shop?.id && req.auth) req.auth.activeShopId = Number(shop.id);
      const payload = requestPayload(req);
      const credits = Math.max(0, Math.trunc(Number(estimate(req, payload)) || 0));
      reservation = await reserveShopCredits({
        auth: req.auth,
        shop,
        operationKey: normalizedOperation,
        credits,
        idempotencyKey: idempotencyKey(normalizedOperation, req),
        metadata: {
          route: req.originalUrl || req.url || null,
          method: req.method || null,
          estimated_units: payload.units || payload.count || null,
        },
      });
      req.creditReservation = reservation;
      req.creditCost = { operationKey: normalizedOperation, credits };

      let settled = false;
      res.on("finish", () => {
        if (settled || !reservation) return;
        settled = true;
        const success = Number(res.statusCode || 500) < 400;
        settleShopCredits(reservation, {
          release: !success,
        }).catch(() => {});
      });

      return next();
    } catch (error) {
      if (reservation) {
        await settleShopCredits(reservation, { release: true }).catch(() => {});
      }
      if (error instanceof HubBillingError) {
        return sendBillingError(res, error);
      }
      return next(error);
    }
  };
}

module.exports = {
  chargeOperation,
};
