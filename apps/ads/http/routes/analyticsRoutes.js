"use strict";

const express = require("express");
const { getAppPool } = require("../../infrastructure/db/pool");
const { GoogleAdsRepository } = require("../../infrastructure/google/googleAdsRepository");
const { GoogleAnalyticsRepository } = require("../../infrastructure/analytics/googleAnalyticsRepository");
const { GoogleAnalyticsService } = require("../../application/analytics/googleAnalyticsService");

function createAnalyticsRouter() {
  const router = express.Router();
  let service;
  const getService = () => {
    if (!service) {
      const pool = getAppPool();
      service = new GoogleAnalyticsService(new GoogleAnalyticsRepository(pool), new GoogleAdsRepository(pool));
    }
    return service;
  };

  router.get("/google", async (req, res, next) => {
    try {
      const payload = await getService().getAnalytics(req.adsIdentity, {
        range: req.query.range,
        accountId: req.query.accountId ? String(req.query.accountId) : null,
      });
      res.json({ success: true, ...payload });
    } catch (error) { next(error); }
  });

  return router;
}
module.exports = { createAnalyticsRouter };
