"use strict";

const express = require("express");
const FullService = require("../services/fullService");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

function sendError(res, error, fallback) {
  const status = Number(error?.statusCode || error?.status || 500);
  return res.status(status).json({
    ok: false,
    error: fallback,
    detail: error?.message || String(error),
  });
}

function currentMeliContaIdOrThrow(res) {
  const id = FullService.currentMeliContaId(res);
  if (!id) {
    const err = new Error("Conta Mercado Livre nao identificada para esta sessao.");
    err.statusCode = 400;
    throw err;
  }
  return id;
}

router.get("/products", async (req, res) => {
  try {
    const meliContaId = currentMeliContaIdOrThrow(res);
    const payload = await FullService.listProducts({
      meliContaId,
      q: req.query.q,
      status: req.query.status,
      sort: req.query.sort,
      limit: req.query.limit,
    });
    return res.json(payload);
  } catch (error) {
    console.error("[Full] products failed:", error);
    return sendError(res, error, "full_products_failed");
  }
});

router.post(
  "/sync",
  createAuditAction({
    evento: "full_sync_requested",
    metadata: () => ({ source: "full_screen" }),
  }),
  async (req, res) => {
    try {
      const payload = await FullService.syncProducts({ req, res });
      return res.json(payload);
    } catch (error) {
      console.error("[Full] sync failed:", error);
      return sendError(res, error, "full_sync_failed");
    }
  },
);

router.post("/planner", async (req, res) => {
  try {
    const payload = await FullService.buildPlanner({ req, res, input: req.body || {} });
    return res.json(payload);
  } catch (error) {
    console.error("[Full] planner failed:", error);
    return sendError(res, error, "full_planner_failed");
  }
});

router.get("/plans", async (_req, res) => {
  try {
    const meliContaId = currentMeliContaIdOrThrow(res);
    const payload = await FullService.listPlans({ meliContaId });
    return res.json(payload);
  } catch (error) {
    console.error("[Full] plans failed:", error);
    return sendError(res, error, "full_plans_failed");
  }
});

router.post(
  "/plans",
  createAuditAction({
    evento: "full_plan_saved",
    metadata: (req) => ({
      period: req.body?.period || req.body?.periodo || null,
      coverage_days: req.body?.coverage_days || null,
    }),
  }),
  async (req, res) => {
    try {
      const payload = await FullService.savePlan({ req, res, input: req.body || {} });
      return res.json(payload);
    } catch (error) {
      console.error("[Full] save plan failed:", error);
      return sendError(res, error, "full_plan_save_failed");
    }
  },
);

router.get("/plans/:id", async (req, res) => {
  try {
    const meliContaId = currentMeliContaIdOrThrow(res);
    const payload = await FullService.getPlan({
      meliContaId,
      planId: Number(req.params.id),
    });
    return res.json(payload);
  } catch (error) {
    console.error("[Full] plan detail failed:", error);
    return sendError(res, error, "full_plan_detail_failed");
  }
});

router.put("/plans/:id", async (req, res) => {
  try {
    const meliContaId = currentMeliContaIdOrThrow(res);
    const payload = await FullService.updatePlan({
      meliContaId,
      planId: Number(req.params.id),
      input: req.body || {},
    });
    return res.json(payload);
  } catch (error) {
    console.error("[Full] update plan failed:", error);
    return sendError(res, error, "full_plan_update_failed");
  }
});

router.delete(
  "/plans/:id",
  createAuditAction({
    evento: "full_plan_deleted",
    metadata: (req) => ({ plan_id: Number(req.params?.id || 0) || null }),
  }),
  async (req, res) => {
    try {
      const meliContaId = currentMeliContaIdOrThrow(res);
      const payload = await FullService.deletePlan({
        meliContaId,
        planId: Number(req.params.id),
      });
      return res.json(payload);
    } catch (error) {
      console.error("[Full] delete plan failed:", error);
      return sendError(res, error, "full_plan_delete_failed");
    }
  },
);

module.exports = router;
