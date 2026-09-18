"use strict";

const express = require("express");
const { getAppPool } = require("../../infrastructure/db/pool");
const { GoogleAdsRepository } = require("../../infrastructure/google/googleAdsRepository");
const { MultichannelAnalyticsRepository } = require("../../infrastructure/analytics/multichannelAnalyticsRepository");
const { MultichannelAnalyticsService } = require("../../application/analytics/multichannelAnalyticsService");

function createIntelligenceRouter() {
  const router = express.Router();
  let service;
  const getService = () => {
    if (!service) {
      const pool = getAppPool();
      service = new MultichannelAnalyticsService(
        new MultichannelAnalyticsRepository(pool),
        new GoogleAdsRepository(pool),
      );
    }
    return service;
  };

  router.get("/multichannel", async (req, res, next) => {
    try {
      const payload = await getService().getContext(req.adsIdentity, { range: req.query.range });
      res.json({ success: true, ...payload });
    } catch (error) { next(error); }
  });

  router.put("/targets", async (req, res, next) => {
    try {
      const targets = await getService().saveTargets(req.adsIdentity, req.body || {});
      res.json({ success: true, targets });
    } catch (error) { next(error); }
  });

  router.put("/meta/accounts/:accountId/primary-conversion", async (req, res, next) => {
    try {
      const mapping = await getService().saveMetaPrimaryConversion(req.adsIdentity, req.params.accountId, req.body || {});
      res.json({ success: true, mapping });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createIntelligenceRouter };
