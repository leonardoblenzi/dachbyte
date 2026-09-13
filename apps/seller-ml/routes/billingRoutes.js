"use strict";

const express = require("express");
const {
  createCreditTopupCheckout,
  getCreditAccountAccess,
  getCreditActivity,
  getCreditPolicy,
  HubCreditError,
} = require("../services/hubCreditsService");

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
  return (
    req.user?.email ||
    req.user?.email_usuario ||
    req.user?.login ||
    req.user?.username ||
    null
  );
}

function viewerName(req) {
  return (
    req.user?.nome ||
    req.user?.name ||
    req.user?.display_name ||
    req.user?.email ||
    null
  );
}

router.get("/credits", async (_req, res) => {
  try {
    const data = await getCreditAccountAccess({
      mlCreds: res.locals.mlCreds || {},
      account: res.locals.account || null,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubCreditError) {
      return errorResponse(res, error, "Nao foi possivel carregar os creditos.");
    }
    console.error("[billingRoutes] GET /credits:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credits_load_failed" });
  }
});

router.get("/credits/activity", async (req, res) => {
  try {
    const data = await getCreditActivity({
      mlCreds: res.locals.mlCreds || {},
      account: res.locals.account || null,
      limit: req.query?.limit || 50,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubCreditError) {
      return errorResponse(res, error, "Nao foi possivel carregar o extrato de creditos.");
    }
    console.error("[billingRoutes] GET /credits/activity:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_activity_load_failed" });
  }
});

router.get("/credit-policy", async (_req, res) => {
  try {
    const data = await getCreditPolicy();
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error instanceof HubCreditError) {
      return errorResponse(res, error, "Nao foi possivel carregar a politica de creditos.");
    }
    console.error("[billingRoutes] GET /credit-policy:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_policy_load_failed" });
  }
});

router.post("/credits/topup-checkout", express.json({ limit: "80kb" }), async (req, res) => {
  try {
    const packageCode = String(req.body?.package_code || "").trim();
    if (!packageCode) {
      return res.status(400).json({ ok: false, error: "package_code_required" });
    }

    const checkout = await createCreditTopupCheckout({
      mlCreds: res.locals.mlCreds || {},
      account: res.locals.account || null,
      packageCode,
      customerEmail: req.body?.customer_email || viewerEmail(req),
      customerName: req.body?.customer_name || viewerName(req),
      successUrl: req.body?.success_url || null,
    });

    return res.json({ ok: true, ...checkout });
  } catch (error) {
    if (error instanceof HubCreditError) {
      return errorResponse(res, error, "Nao foi possivel iniciar a recarga.");
    }
    console.error("[billingRoutes] POST /credits/topup-checkout:", error?.message || error);
    return res.status(500).json({ ok: false, error: "credit_topup_checkout_failed" });
  }
});

module.exports = router;
