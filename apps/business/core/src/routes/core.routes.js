const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const CoreController = require("../controllers/CoreController");
const CoreOperationsController = require("../controllers/CoreOperationsController");
const AuthController = require("../controllers/AuthController");
const RuntimeController = require("../controllers/RuntimeController");
const IntegrationController = require("../controllers/IntegrationController");
const IntegrationWebhookController = require("../controllers/IntegrationWebhookController");
const HealthController = require("../controllers/HealthController");
const authRoutes = require("./auth.routes");
const { ensureAuth, requireCompanyAccess, requireMaster } = require("../middlewares/authMiddleware");
const requireRuntimePermission = require("../middlewares/requireRuntimePermission");
const requireRuntimeCapability = require("../middlewares/requireRuntimeCapability");
const tenantContext = require("../middlewares/tenantContext");
const { mountExtensionRoutes } = require("../platform/extensions/mountExtensionRoutes");

const router = express.Router();

router.use("/auth", authRoutes);
router.get("/health", asyncHandler(HealthController.health));
router.get("/segments", asyncHandler(CoreController.listSegments));
router.get("/modules", asyncHandler(CoreController.listModules));
router.get("/screens", asyncHandler(CoreController.listScreens));
router.get("/runtime/status", asyncHandler(RuntimeController.status));
router.post("/webhooks/:provider", asyncHandler(IntegrationWebhookController.receive));

router.use(ensureAuth);

router.get("/master/overview", requireMaster, asyncHandler(AuthController.masterOverview));
router.get("/master/observability", requireMaster, asyncHandler(IntegrationController.globalObservability));

router.get("/runtime/companies", asyncHandler(RuntimeController.listCompanies));
router.get("/import-templates/:entity.xlsx", asyncHandler(CoreOperationsController.downloadImportTemplate));
router.post("/runtime/companies", requireMaster, asyncHandler(RuntimeController.createCompany));
router.use("/runtime/companies/:companyId", tenantContext);
router.use("/runtime/companies/:companyId", requireCompanyAccess);
router.get("/runtime/companies/:companyId/workspace", asyncHandler(RuntimeController.getWorkspace));
router.get("/runtime/companies/:companyId/commercial", requireRuntimePermission("services:read"), asyncHandler(RuntimeController.getCommercialProducts));
router.post("/runtime/companies/:companyId/commercial/products/:productKey/request", requireRuntimePermission("services:write"), asyncHandler(RuntimeController.requestCommercialProduct));
router.patch("/runtime/companies/:companyId/commercial/products/:productKey", requireMaster, asyncHandler(RuntimeController.setCommercialProduct));
router.get("/runtime/companies/:companyId/integrations/summary", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.summary));
router.get("/runtime/companies/:companyId/integrations/accounts", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.accounts));
router.post("/runtime/companies/:companyId/integrations/accounts", requireRuntimePermission("integrations:write"), asyncHandler(IntegrationController.saveAccount));
router.patch("/runtime/companies/:companyId/integrations/accounts/:accountId/status", requireRuntimePermission("integrations:write"), asyncHandler(IntegrationController.setAccountStatus));
router.get("/runtime/companies/:companyId/integrations/mappings", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.mappings));
router.put("/runtime/companies/:companyId/integrations/mappings", requireRuntimePermission("integrations:write"), asyncHandler(IntegrationController.saveMapping));
router.get("/runtime/companies/:companyId/integrations/jobs", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.jobs));
router.post("/runtime/companies/:companyId/integrations/jobs/:jobId/retry", requireRuntimePermission("integrations:write"), asyncHandler(IntegrationController.retryJob));
router.get("/runtime/companies/:companyId/integrations/outbox", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.outbox));
router.post("/runtime/companies/:companyId/integrations/outbox/:eventId/retry", requireRuntimePermission("integrations:write"), asyncHandler(IntegrationController.retryOutbox));
router.get("/runtime/companies/:companyId/integrations/webhooks", requireRuntimePermission("integrations:read"), asyncHandler(IntegrationController.webhooks));
router.get("/runtime/companies/:companyId/data/customers", requireRuntimePermission("customers:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "customers")));
router.get("/runtime/companies/:companyId/data/products", requireRuntimePermission("products:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "products")));
router.get("/runtime/companies/:companyId/data/product-categories", requireRuntimePermission("products:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "product_categories")));
router.get("/runtime/companies/:companyId/data/product-brands", requireRuntimePermission("products:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "product_brands")));
router.get("/runtime/companies/:companyId/data/sales", requireRuntimePermission("sales:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "sales")));
router.get("/runtime/companies/:companyId/data/receivables", requireRuntimePermission("receivables:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "receivables")));
router.get("/runtime/companies/:companyId/data/inventory-movements", requireRuntimePermission("inventory:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "inventory_movements")));
router.get("/runtime/companies/:companyId/data/stock-reservations", requireRuntimePermission("inventory:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "stock_reservations")));
router.get("/runtime/companies/:companyId/data/cash-movements", requireRuntimePermission("cash_register:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "cash_movements")));
router.get("/runtime/companies/:companyId/data/cash-sessions", requireRuntimePermission("cash_register:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "cash_sessions")));
router.get("/runtime/companies/:companyId/data/receipts", requireRuntimePermission("receipts:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "receipts")));
router.get("/runtime/companies/:companyId/data/expenses", requireRuntimePermission("expenses:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "expenses")));
router.get("/runtime/companies/:companyId/data/service-orders", requireRuntimePermission("service_orders:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "service_orders")));
router.get("/runtime/companies/:companyId/data/payment-methods", requireRuntimePermission("payments:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "payment_methods")));
router.get("/runtime/companies/:companyId/data/users", requireRuntimePermission("users:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "users")));
router.get("/runtime/companies/:companyId/data/audit-logs", requireRuntimePermission("audit:read"), asyncHandler((req, res) => RuntimeController.getRuntimeData(req, res, "audit_logs")));
router.get("/runtime/companies/:companyId/reports/summary", requireRuntimePermission("reports:read"), asyncHandler(RuntimeController.getRuntimeReports));
router.post("/runtime/companies/:companyId/onboarding/company-profile", asyncHandler(RuntimeController.completeCompanyProfile));
router.post("/runtime/companies/:companyId/onboarding/sector", asyncHandler(RuntimeController.selectOnboardingSector));
router.post("/runtime/companies/:companyId/apply-segment", requireMaster, asyncHandler(RuntimeController.applySegmentTemplate));
router.patch("/runtime/companies/:companyId/settings", requireRuntimePermission("settings:write"), asyncHandler(RuntimeController.updateCompanySettings));
router.patch("/runtime/companies/:companyId/configuration/overrides", requireMaster, asyncHandler(RuntimeController.updateCompanyOverrides));
router.post("/runtime/companies/:companyId/customers", requireRuntimePermission("customers:write"), asyncHandler(RuntimeController.createCustomer));
router.get("/runtime/companies/:companyId/customers/:customerId/account", requireRuntimePermission("customers:read"), asyncHandler(RuntimeController.getCustomerAccount));
router.patch("/runtime/companies/:companyId/customers/:customerId", requireRuntimePermission("customers:write"), asyncHandler(RuntimeController.updateCustomer));
router.post("/runtime/companies/:companyId/customers/:customerId/deactivate", requireRuntimePermission("customers:write"), asyncHandler(RuntimeController.setCustomerActive));
router.post("/runtime/companies/:companyId/customers/:customerId/activate", requireRuntimePermission("customers:write"), asyncHandler(RuntimeController.setCustomerActive));
router.delete("/runtime/companies/:companyId/customers/:customerId", requireRuntimePermission("customers:write"), asyncHandler(RuntimeController.deleteCustomer));
router.post("/runtime/companies/:companyId/product-categories", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.createProductCategory));
router.patch("/runtime/companies/:companyId/product-categories/:categoryId", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.updateProductCategory));
router.post("/runtime/companies/:companyId/product-categories/:categoryId/deactivate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductCategoryActive));
router.post("/runtime/companies/:companyId/product-categories/:categoryId/activate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductCategoryActive));
router.post("/runtime/companies/:companyId/product-brands", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.createProductBrand));
router.patch("/runtime/companies/:companyId/product-brands/:brandId", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.updateProductBrand));
router.post("/runtime/companies/:companyId/product-brands/:brandId/deactivate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductBrandActive));
router.post("/runtime/companies/:companyId/product-brands/:brandId/activate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductBrandActive));
router.post("/runtime/companies/:companyId/products", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.createProduct));
router.patch("/runtime/companies/:companyId/products/:productId", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.updateProduct));
router.post("/runtime/companies/:companyId/products/:productId/deactivate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductActive));
router.post("/runtime/companies/:companyId/products/:productId/activate", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.setProductActive));
router.delete("/runtime/companies/:companyId/products/:productId", requireRuntimePermission("products:write"), asyncHandler(RuntimeController.deleteProduct));
router.post("/runtime/companies/:companyId/inventory/movements", requireRuntimePermission("inventory:write"), asyncHandler(RuntimeController.createInventoryMovement));
router.post("/runtime/companies/:companyId/sales", requireRuntimePermission("sales:write"), asyncHandler(RuntimeController.createSale));
router.get("/runtime/companies/:companyId/sales/:saleId/history", requireRuntimePermission("sales:read"), asyncHandler(RuntimeController.getSaleHistory));
router.patch("/runtime/companies/:companyId/sales/:saleId", requireRuntimePermission("sales:write"), asyncHandler(RuntimeController.updateSale));
router.post("/runtime/companies/:companyId/sales/:saleId/complete-delivery", requireRuntimePermission("sales:write"), asyncHandler(RuntimeController.completeSaleDelivery));
router.post("/runtime/companies/:companyId/sales/:saleId/cancel", requireRuntimePermission("sales:write"), asyncHandler(RuntimeController.cancelSale));
router.delete("/runtime/companies/:companyId/sales/:saleId", requireRuntimePermission("sales:write"), asyncHandler(RuntimeController.deleteCanceledSale));
router.post("/runtime/companies/:companyId/cash/sessions", requireRuntimePermission("cash_register:write"), asyncHandler(RuntimeController.openCashSession));
router.post("/runtime/companies/:companyId/cash/sessions/:sessionId/close", requireRuntimePermission("cash_register:write"), asyncHandler(RuntimeController.closeCashSession));
router.post("/runtime/companies/:companyId/cash/movements", requireRuntimePermission("cash_register:write"), asyncHandler(RuntimeController.createCashMovement));
router.post("/runtime/companies/:companyId/receivables", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.createReceivable));
router.patch("/runtime/companies/:companyId/receivables/:receivableId/due-date", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.updateReceivableDueDate));
router.post("/runtime/companies/:companyId/receivables/:receivableId/receive", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.receiveReceivable));
router.post("/runtime/companies/:companyId/receivables/:receivableId/deposit-check", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.depositCheckReceivable));
router.post("/runtime/companies/:companyId/receivables/:receivableId/return-check", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.returnCheckReceivable));
router.post("/runtime/companies/:companyId/receivables/:receivableId/cancel", requireRuntimePermission("receivables:write"), asyncHandler(RuntimeController.cancelReceivable));
router.post("/runtime/companies/:companyId/expenses", requireRuntimePermission("expenses:write"), asyncHandler(RuntimeController.createExpense));
router.patch("/runtime/companies/:companyId/expenses/:expenseId", requireRuntimePermission("expenses:write"), asyncHandler(RuntimeController.updateExpense));
router.post("/runtime/companies/:companyId/expenses/:expenseId/pay", requireRuntimePermission("expenses:write"), asyncHandler(RuntimeController.payExpense));
router.post("/runtime/companies/:companyId/expenses/:expenseId/cancel", requireRuntimePermission("expenses:write"), asyncHandler(RuntimeController.cancelExpense));
router.post("/runtime/companies/:companyId/service-orders", requireRuntimePermission("service_orders:write"), asyncHandler(RuntimeController.createServiceOrder));
router.patch("/runtime/companies/:companyId/service-orders/:serviceOrderId", requireRuntimePermission("service_orders:write"), asyncHandler(RuntimeController.updateServiceOrder));
router.post("/runtime/companies/:companyId/payment-methods", requireRuntimePermission("payments:write"), asyncHandler(RuntimeController.savePaymentMethod));
router.post("/runtime/companies/:companyId/users", requireRuntimePermission("users:write"), asyncHandler(RuntimeController.createUser));
router.patch("/runtime/companies/:companyId/users/:userId", requireRuntimePermission("users:write"), asyncHandler(RuntimeController.updateUser));
router.put("/runtime/companies/:companyId/configuration/:listKey", requireRuntimePermission("settings:write"), asyncHandler(RuntimeController.saveConfigurationItem));
router.delete("/runtime/companies/:companyId/configuration/:listKey/:itemId", requireRuntimePermission("settings:write"), asyncHandler(RuntimeController.deleteConfigurationItem));

mountExtensionRoutes(router, { asyncHandler, requireRuntimeCapability, requireRuntimePermission });
router.get("/templates/:segmentKey", asyncHandler(CoreController.getSegmentTemplate));
router.get("/roles", asyncHandler(CoreOperationsController.listRoles));
router.get("/permissions", asyncHandler(CoreOperationsController.listPermissions));

router.use((req, res) => {
  res.status(404).json({
    error: {
      message: "Rota do Volt Core nao encontrada.",
      code: "CORE_ROUTE_NOT_FOUND",
    },
  });
});

module.exports = router;
