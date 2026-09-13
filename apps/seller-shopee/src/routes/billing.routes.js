"use strict";

const express = require("express");
const { resolveShop } = require("../utils/resolveShop");
const {
  buildPlanCheckoutUrl,
  createCreditTopupCheckout,
  getCreditPolicy,
  getShopCreditActivity,
  HubBillingError,
} = require("../services/hubResourceBillingService");

const router = express.Router();

function errorResponse(res, error, fallbackMessage) {
  const statusCode = Number(error?.statusCode || error?.status || 503);
  return res.status(statusCode).json({
    ok: false,
    error: error?.code || "billing_request_failed",
    message: error?.message || fallbackMessage,
    details: error?.details || null,
  });
}

function viewerEmail(req) {
  return req.auth?.email || req.body?.customer_email || null;
}

function viewerName(req) {
  return req.body?.customer_name || req.auth?.accountName || req.auth?.email || null;
}

router.get("/billing/credit-policy", async (_req, res) => {
  try {
    const data = await getCreditPolicy();
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubBillingError) {
      return errorResponse(res, error, "Nao foi possivel carregar a politica de creditos.");
    }
    console.error("[shopee-billing] GET /billing/credit-policy:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_policy_load_failed" });
  }
});

router.get("/billing/credits", async (req, res) => {
  try {
    const shop = await resolveShop(req, "active");
    const data = await getShopCreditActivity({
      auth: req.auth,
      shop,
      limit: req.query?.limit || 12,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubBillingError) {
      return errorResponse(res, error, "Nao foi possivel carregar os creditos.");
    }
    console.error("[shopee-billing] GET /billing/credits:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credits_load_failed" });
  }
});

router.get("/billing/credits/activity", async (req, res) => {
  try {
    const shop = await resolveShop(req, "active");
    const data = await getShopCreditActivity({
      auth: req.auth,
      shop,
      limit: req.query?.limit || 50,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubBillingError) {
      return errorResponse(res, error, "Nao foi possivel carregar o extrato de creditos.");
    }
    console.error("[shopee-billing] GET /billing/credits/activity:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_activity_load_failed" });
  }
});

router.post("/billing/subscription-checkout", async (req, res) => {
  try {
    const shop = await resolveShop(req, "active");
    const checkoutUrl = buildPlanCheckoutUrl({
      auth: req.auth,
      shop,
      cycle: req.body?.cycle || "monthly",
      orderRangeCode: req.body?.order_range_code || null,
      customerEmail: req.body?.customer_email || viewerEmail(req),
      customerName: req.body?.customer_name || viewerName(req),
      successUrl: req.body?.success_url || null,
    });

    if (!checkoutUrl) {
      return res.status(409).json({ ok: false, error: "subscription_checkout_context_missing" });
    }

    return res.json({ ok: true, checkout_url: checkoutUrl });
  } catch (error) {
    if (error instanceof HubBillingError) {
      return errorResponse(res, error, "Nao foi possivel iniciar a renovacao do plano.");
    }
    console.error("[shopee-billing] POST /billing/subscription-checkout:", error?.message || error);
    return res.status(500).json({ ok: false, error: "subscription_checkout_failed" });
  }
});

router.post("/billing/credits/topup-checkout", async (req, res) => {
  try {
    const packageCode = String(req.body?.package_code || "").trim();
    if (!packageCode) {
      return res.status(400).json({ ok: false, error: "package_code_required" });
    }

    const shop = await resolveShop(req, "active");
    const checkout = await createCreditTopupCheckout({
      auth: req.auth,
      shop,
      packageCode,
      customerEmail: req.body?.customer_email || viewerEmail(req),
      customerName: req.body?.customer_name || viewerName(req),
      successUrl: req.body?.success_url || null,
    });

    return res.json({ ok: true, ...checkout });
  } catch (error) {
    if (error instanceof HubBillingError) {
      return errorResponse(res, error, "Nao foi possivel iniciar a recarga.");
    }
    console.error("[shopee-billing] POST /billing/credits/topup-checkout:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_topup_checkout_failed" });
  }
});

module.exports = router;
