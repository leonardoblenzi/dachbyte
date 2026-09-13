const express = require("express");
const OrdersController = require("../controllers/OrdersController");
const OrderSyncController = require("../controllers/OrderSyncController");
const { requireAuth } = require("../middlewares/sessionAuth");
const DebugShopeeController = require("../controllers/DebugShopeeController");
const { requireDebugToken } = require("../middlewares/debugToken");
const OrderAddressAlertsController = require("../controllers/OrderAddressAlertsController");
const GeoSalesController = require("../controllers/GeoSalesController");
const DashboardController = require("../controllers/DashboardController");
const DebugController = require("../controllers/DebugController");
const StockAlertController = require("../controllers/StockAlertController");
const PriceIncreaseController = require("../controllers/PriceIncreaseController");
const ShopeePushNoticeController = require("../controllers/ShopeePushNoticeController");

const router = express.Router();
router.use(requireAuth);

// 🌎 Geografia de vendas (mapa)
router.get("/shops/active/geo/sales", GeoSalesController.byState);
router.get("/shops/active/geo/sales/:uf", GeoSalesController.byCityInState);

// Dashboard
router.get(
  "/shops/active/dashboard/control-panel",
  DashboardController.controlPanelSummary,
);
router.get(
  "/shops/active/dashboard/monthly-sales",
  DashboardController.monthlySales,
);
router.get(
  "/shops/active/dashboard/today-sales",
  DashboardController.todaySales,
);
router.get(
  "/shops/active/dashboard/top-sellers-month",
  DashboardController.topSellersMonth,
);
router.get(
  "/shops/active/dashboard/stock-alert/overview",
  StockAlertController.overview,
);
router.get(
  "/shops/active/dashboard/stock-alert/products",
  StockAlertController.listProducts,
);
router.post(
  "/shops/active/dashboard/stock-alert/monitor",
  StockAlertController.monitorItems,
);
router.post(
  "/shops/active/dashboard/stock-alert/sync-stock",
  StockAlertController.syncMonitoredStock,
);
router.post(
  "/shops/active/dashboard/stock-alert/:itemId/purchase",
  StockAlertController.purchaseMarked,
);
router.post(
  "/shops/active/dashboard/stock-alert/:itemId/confirm-arrival",
  StockAlertController.confirmItemArrival,
);
router.delete(
  "/shops/active/dashboard/stock-alert/:itemId",
  StockAlertController.unmonitorItem,
);
router.get(
  "/shops/active/dashboard/price-increase/overview",
  PriceIncreaseController.dashboardOverview,
);
router.get(
  "/shops/active/dashboard/price-increase/recent",
  PriceIncreaseController.listRecent,
);
router.get(
  "/shops/active/shopee-notices",
  ShopeePushNoticeController.list,
);
router.get(
  "/shops/active/shopee-notices/export",
  ShopeePushNoticeController.exportCsv,
);
router.post(
  "/shops/active/shopee-notices/read",
  ShopeePushNoticeController.markRead,
);
router.post(
  "/shops/active/shopee-notices/delete",
  ShopeePushNoticeController.remove,
);
router.post(
  "/shops/active/shopee-notices/:id/read",
  ShopeePushNoticeController.markRead,
);
router.post(
  "/shops/active/shopee-notices/:id/delete",
  ShopeePushNoticeController.remove,
);

// Debug
router.get("/debug/egress-ip", requireDebugToken, DebugController.egressIp);

// ✅ Alertas (MUITO IMPORTANTE: antes de /orders/:orderSn)
router.get(
  "/shops/active/orders/address-alerts",
  OrderAddressAlertsController.listOpen,
);
router.get(
  "/shops/active/orders/:orderSn/address-alerts",
  OrderAddressAlertsController.getOpenByOrderSn,
);
router.patch(
  "/shops/active/orders/address-alerts/:id/resolve",
  OrderAddressAlertsController.resolve,
);

// Sync (colocar antes de /:orderSn também é boa prática)
router.post("/shops/active/orders/sync", OrderSyncController.sync);
router.post("/shops/:shopId/orders/sync", OrderSyncController.sync);
router.get("/shops/active/orders/sync/:jobId", OrderSyncController.status);

// Debug Shopee / Totals (antes de /:orderSn)
router.get(
  "/shops/active/orders/:orderSn/debug-shopee-detail",
  requireDebugToken,
  DebugShopeeController.testShopeeOrderDetailMask,
);
router.get(
  "/shops/:shopId/orders/:orderSn/debug-shopee-detail",
  requireDebugToken,
  DebugShopeeController.testShopeeOrderDetailMask,
);
router.get(
  "/shops/active/orders/:orderSn/debug-totals",
  requireDebugToken,
  DebugShopeeController.debugOrderTotals,
);

// Orders (genéricas por último)
router.get("/shops/active/orders", OrdersController.list);
router.get("/shops/active/orders/:orderSn/portal-ref", OrdersController.portalRef);
router.get("/shops/active/orders/:orderSn", OrdersController.detail);

router.get("/shops/:shopId/orders", OrdersController.list);
router.get("/shops/:shopId/orders/:orderSn", OrdersController.detail);

module.exports = router;
