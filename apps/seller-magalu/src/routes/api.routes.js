"use strict";

const express = require("express");
const queueNames = require("../config/queueNames");
const oauthController = require("../controllers/oauthController");
const catalogController = require("../controllers/catalogController");
const writeController = require("../controllers/writeController");
const accountRoutes = require("./account.routes");
const skuManagementRoutes = require("./skuManagement.routes");
const env = require("../config/env");

const router = express.Router();
router.get("/session", (req, res) => { const identity=req.magaluIdentity; return res.json({ok:true,module:"magalu",user:{email:identity.email,name:identity.name},subscription:identity.subscription||null}); });
router.get("/accounts", oauthController.accounts);
router.get("/oauth/status", oauthController.status);
router.post("/accounts/:accountId/refresh", oauthController.refresh);
router.use("/account", accountRoutes);
router.get("/catalog/status", catalogController.status);
router.get("/catalog/skus", catalogController.list);
router.get("/catalog/skus/:sku", catalogController.detail);
router.post("/catalog/sync", catalogController.sync);
router.post("/catalog/test", catalogController.diagnostics);
router.post("/catalog/skus/:sku/reconcile", catalogController.reconcile);
router.get("/catalog/runs", catalogController.runs);
router.get("/writes/status", writeController.status);
router.post("/writes/preview", writeController.preview);
router.post("/writes/apply", writeController.apply);
router.get("/writes/operations", writeController.operations);
router.post("/writes/operations/:operationId/reverify", writeController.reverify);
router.get("/writes/operations/:operationId", writeController.operation);
router.use("/sku-management", skuManagementRoutes);
router.get("/foundation", (_req, res) => res.json({
  ok:true,stage:5,revision:"5.0",module:"seller-magalu",oauth_enabled:true,catalog_read_enabled:true,
  remote_writes_enabled:env.MAGALU_WRITE_ENABLED,protected_writes:true,sku_mass_write_enabled:env.MAGALU_SKU_WRITE_ENABLED,
  queues:Object.values(queueNames),routes:{app:"/magalu",sku_management:"/magalu/gestao-skus",oauth_start:"/magalu/auth/start",callback:"/magalu/auth/callback",catalog:"/magalu/api/catalog/skus",catalog_sync:"/magalu/api/catalog/sync",catalog_test:"/magalu/api/catalog/test",write_preview:"/magalu/api/writes/preview",write_apply:"/magalu/api/writes/apply",sku_mass_preview:"/magalu/api/sku-management/preview",sku_mass_apply:"/magalu/api/sku-management/apply",webhook_v1:"/magalu/webhooks/v1"}
}));
module.exports = router;
