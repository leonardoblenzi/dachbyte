"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete, requireCsrf } = require("../auth");
const { requirePermission } = require("../permissions");
const { decisionOverview, executeDecisionRun, upsertPolicy, upsertPerformanceSample, reviewDecision, simulateDecision } = require("../decision/service");

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

router.get("/pricing", requirePermission("pricing.read"), async (req, res, next) => {
  try { res.json(await decisionOverview(req.vpAuth, req.query)); } catch (error) { next(error); }
});
router.post("/pricing/run", requireCsrf, requirePermission("pricing.manage"), async (req, res, next) => {
  try { res.status(201).json(await executeDecisionRun(req.vpAuth, req.body || {}, req)); } catch (error) { next(error); }
});
router.post("/pricing/policies", requireCsrf, requirePermission("pricing.manage"), async (req, res, next) => {
  try { res.status(201).json({ policy: await upsertPolicy(req.vpAuth, req.body || {}, req) }); } catch (error) { next(error); }
});
router.post("/pricing/samples", requireCsrf, requirePermission("pricing.manage"), async (req, res, next) => {
  try { res.status(201).json({ sample: await upsertPerformanceSample(req.vpAuth, req.body || {}, req) }); } catch (error) { next(error); }
});
router.patch("/pricing/decisions/:id/review", requireCsrf, requirePermission("pricing.manage"), async (req, res, next) => {
  try { res.json({ decision: await reviewDecision(req.vpAuth, req.params.id, req.body || {}, req) }); } catch (error) { next(error); }
});
router.post("/pricing/simulate", requireCsrf, requirePermission("pricing.simulate"), async (req, res, next) => {
  try { res.json(simulateDecision(req.body || {})); } catch (error) { next(error); }
});

module.exports = { decisionRouter: router };
