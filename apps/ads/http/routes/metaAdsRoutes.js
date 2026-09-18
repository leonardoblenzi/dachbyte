"use strict";

const express = require("express");
const { getAppPool } = require("../../infrastructure/db/pool");
const { MetaAdsRepository } = require("../../infrastructure/meta/metaAdsRepository");
const { MetaAdsService } = require("../../application/meta/metaAdsService");

function createMetaAdsRouter() {
  const router = express.Router();
  let service;
  const getService = () => {
    if (!service) service = new MetaAdsService(new MetaAdsRepository(getAppPool()));
    return service;
  };

  router.get("/status", async (req, res, next) => {
    try { res.json({ success: true, ...(await getService().status(req.adsIdentity)) }); }
    catch (error) { next(error); }
  });

  router.get("/oauth/start", async (req, res, next) => {
    try { res.redirect(302, await getService().beginOAuth(req.adsIdentity, req.query.returnTo)); }
    catch (error) { next(error); }
  });

  router.get("/oauth/callback", async (req, res) => {
    const returnTo = "/ads/app/meta";
    try {
      if (req.query.error) {
        const message = encodeURIComponent(String(req.query.error_description || req.query.error_message || req.query.error));
        return res.redirect(302, `${returnTo}?meta=cancelled&message=${message}`);
      }
      if (!req.query.code || !req.query.state) {
        return res.redirect(302, `${returnTo}?meta=error&message=${encodeURIComponent("OAuth Meta sem code/state")}`);
      }
      const result = await getService().completeOAuth(req.adsIdentity, {
        code: String(req.query.code), state: String(req.query.state),
      });
      const target = result.returnTo || returnTo;
      const suffix = target.includes("?") ? "&" : "?";
      return res.redirect(302, `${target}${suffix}meta=connected&accounts=${result.discovery.accounts.length}`);
    } catch (error) {
      console.error("[dach-ads:meta] oauth callback failed", error);
      return res.redirect(302, `${returnTo}?meta=error&message=${encodeURIComponent(error.message || "Falha no OAuth Meta")}`);
    }
  });

  router.post("/connections/:connectionId/discover", async (req, res, next) => {
    try { res.json({ success: true, ...(await getService().rediscover(req.adsIdentity, req.params.connectionId)) }); }
    catch (error) { next(error); }
  });

  router.delete("/connections/:connectionId", async (req, res, next) => {
    try { await getService().disconnect(req.adsIdentity, req.params.connectionId); res.json({ success: true }); }
    catch (error) { next(error); }
  });

  router.put("/accounts/:accountId/selection", async (req, res, next) => {
    try {
      const account = await getService().selectAccount(req.adsIdentity, req.params.accountId, Boolean(req.body?.enabled));
      if (!account) return res.status(404).json({ success: false, error: "meta_account_not_found" });
      res.json({ success: true, account });
    } catch (error) { next(error); }
  });

  router.post("/accounts/:accountId/sync", async (req, res, next) => {
    try {
      const account = await getService().requestSync(req.adsIdentity, req.params.accountId);
      if (!account) return res.status(404).json({ success: false, error: "meta_account_not_found" });
      res.status(202).json({ success: true, queued: true });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createMetaAdsRouter };
