"use strict";

const express = require("express");
const { getAppPool } = require("../../infrastructure/db/pool");
const { GoogleAdsRepository } = require("../../infrastructure/google/googleAdsRepository");
const { MultichannelAnalyticsRepository } = require("../../infrastructure/analytics/multichannelAnalyticsRepository");
const { FzDiagnosticsRepository } = require("../../infrastructure/diagnostics/fzDiagnosticsRepository");
const { MultichannelAnalyticsService } = require("../../application/analytics/multichannelAnalyticsService");
const { FzDiagnosticsService } = require("../../application/diagnostics/fzDiagnosticsService");

function createDiagnosticsRouter() {
  const router = express.Router();
  let service;
  const getService = () => {
    if (!service) {
      const pool = getAppPool();
      const workspaceRepository = new GoogleAdsRepository(pool);
      const multichannelRepository = new MultichannelAnalyticsRepository(pool);
      const multichannelService = new MultichannelAnalyticsService(multichannelRepository, workspaceRepository);
      service = new FzDiagnosticsService({
        repository: new FzDiagnosticsRepository(pool),
        multichannelService,
        multichannelRepository,
        workspaceRepository,
      });
    }
    return service;
  };

  router.get("/", async (req, res, next) => {
    try {
      const payload = await getService().list(req.adsIdentity, { includeResolved: req.query.includeResolved });
      res.json({ success: true, ...payload });
    } catch (error) { next(error); }
  });

  router.post("/run", async (req, res, next) => {
    try {
      const payload = await getService().run(req.adsIdentity, { range: req.body?.range || req.query.range });
      res.json({ success: true, ...payload });
    } catch (error) { next(error); }
  });

  router.patch("/:findingId/status", async (req, res, next) => {
    try {
      const finding = await getService().setStatus(req.adsIdentity, req.params.findingId, String(req.body?.status || ""));
      res.json({ success: true, finding });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createDiagnosticsRouter };
