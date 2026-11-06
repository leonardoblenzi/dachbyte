"use strict";

const express = require("express");
const queueNames = require("../config/queueNames");
const oauthController = require("../controllers/oauthController");
const catalogController = require("../controllers/catalogController");
const writeController = require("../controllers/writeController");
const accountRoutes = require("./account.routes");
const skuManagementRoutes = require("./skuManagement.routes");
const orderRoutes = require("./order.routes");
const dashboardController = require("../controllers/dashboardController");
const rankingController = require("../controllers/rankingController");
const projectionController = require("../controllers/projectionController");
const financialRoutes = require("./financial.routes");
const uxAnalyticsRoutes = require("./uxAnalytics.routes");
const promotionRoutes = require("./promotion.routes");
const processPanelController = require("../controllers/processPanelController");
const promoPriceController = require("../controllers/promoPriceController");
const env = require("../config/env");
const userAccess = require("../services/userAccessService");

const router = express.Router();

// Escrita de preco e estoque usa o mesmo endpoint: o modulo vem do recurso.
function writeModuleFor(resource) {
  const value = String(resource || "").trim().toLowerCase();
  if (value === "price") return "magalu.operacoes.precos";
  if (value === "stock") return "magalu.operacoes.estoque";
  return null;
}
const requireWritePreviewEdit = userAccess.requireEditForWrites((req) => writeModuleFor(req.body?.resource) || "magalu.operacoes.precos");
const requireCampaignEdit = userAccess.requireEditForWrites("magalu.promocoes.campanhas");

// Escritas exigem "Editar" do modulo; consultas via POST seguem liberadas.
router.use("/orders", userAccess.requireEditForWrites("magalu.pedidos", {
  readOnlyPaths: ["/sync", "/:code/reconcile", "/delivery-writes/operations/:operationId/reverify"],
}));
router.use("/sku-management", userAccess.requireEditForWrites("magalu.operacoes.catalogo", {
  readOnlyPaths: [
    "/selection/resolve",
    "/bulk/selections",
    "/bulk/selections/:id/append",
    "/bulk/selections/:id/finalize",
    "/bulk/selections/from-filter",
    "/items/:itemId/reverify",
  ],
}));
router.use("/financial", userAccess.requireEditForWrites("magalu.precificacao.margem", {
  readOnlyPaths: ["/calculator/calculate"],
}));
router.get("/session", (req, res) => { const identity=req.magaluIdentity; return res.json({ok:true,module:"magalu",user:{email:identity.email,name:identity.name},subscription:identity.subscription||null}); });
router.get("/dashboard",dashboardController.status);
router.get("/ranking",rankingController.ranking);
router.get("/projection",projectionController.projection);
router.get("/ranking/config",rankingController.getConfig);
router.put("/ranking/config",userAccess.requireAdmin,rankingController.saveConfig);
router.post("/dashboard/refresh",dashboardController.refresh);
router.get("/dashboard/refresh/:jobId",dashboardController.refreshStatus);
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
router.post("/writes/preview", requireWritePreviewEdit, writeController.preview);
router.post("/writes/apply", writeController.apply);
router.get("/writes/operations", writeController.operations);
router.post("/writes/operations/:operationId/reverify", writeController.reverify);
router.get("/writes/operations/:operationId", writeController.operation);
router.get("/processes", processPanelController.list);
router.get("/processes/:kind/:id", processPanelController.detail);
router.get("/promo-prices",promoPriceController.list);
router.post("/promo-prices/search",promoPriceController.list);
router.post("/promo-prices/export",promoPriceController.exportList);
router.post("/promo-prices/refresh",promoPriceController.refresh);
router.get("/promo-prices/refresh/:id",promoPriceController.refreshStatus);
router.post("/promo-prices/previews",requireCampaignEdit,promoPriceController.createPreview);
router.get("/promo-prices/previews/jobs/:id",promoPriceController.previewJobStatus);
router.get("/promo-prices/previews/:id",promoPriceController.previewPage);
router.put("/promo-prices/previews/:id/rows/:sku",requireCampaignEdit,promoPriceController.updatePreviewRow);
router.get("/promo-prices/previews/:id/export-check",promoPriceController.exportCheck);
router.get("/promo-prices/previews/:id/export",promoPriceController.exportWorkbook);
router.use("/sku-management", skuManagementRoutes);
router.use("/orders", orderRoutes);
router.use("/financial", financialRoutes);
router.use("/ux-analytics", uxAnalyticsRoutes);
router.use("/promotions", promotionRoutes);
router.get("/foundation", (_req, res) => res.json({
  ok:true,stage:8,revision:"8.0",module:"seller-magalu",oauth_enabled:true,catalog_read_enabled:true,
  remote_writes_enabled:env.MAGALU_WRITE_ENABLED,protected_writes:true,sku_mass_write_enabled:env.MAGALU_SKU_WRITE_ENABLED,
  queues:Object.values(queueNames),routes:{app:"/magalu",master_integrations:"/magalu/api/master/integrations",orders_page:"/magalu/pedidos",orders_list:"/magalu/api/orders/list",orders_sync:"/magalu/api/orders/sync",delivery_write_status:"/magalu/api/orders/delivery-writes/status",delivery_write_preview:"/magalu/api/orders/delivery-writes/preview",sku_management:"/magalu/gestao-skus",oauth_start:"/magalu/auth/start",callback:"/magalu/auth/callback",catalog:"/magalu/api/catalog/skus",catalog_sync:"/magalu/api/catalog/sync",catalog_test:"/magalu/api/catalog/test",write_preview:"/magalu/api/writes/preview",write_apply:"/magalu/api/writes/apply",sku_mass_preview:"/magalu/api/sku-management/preview",sku_mass_apply:"/magalu/api/sku-management/apply",webhook_v1:"/magalu/webhooks/v1"}
}));
module.exports = router;
