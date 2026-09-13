const runtime = require("../modules/core/runtime");
const runtimeAccess = require("../modules/core/runtimeAccess");
const { isPermissionEnabled } = require("../modules/core/capabilities/capabilityResolver");

function allowedCompanyIds(req) {
  if (req.user?.is_master || req.user?.isMaster || req.user?.role === "admin_master") return null;
  return new Set((req.user?.companies || []).map((company) => String(company?.id || "")).filter(Boolean));
}

function filterCompanies(req, companies) {
  const allowed = allowedCompanyIds(req);
  return allowed ? companies.filter((company) => allowed.has(String(company.id))) : companies;
}

function inputWithActor(req) {
  const input = { ...(req.body || {}), actorUserId: req.user?.uid || req.user?.id || null };
  const idempotencyHeader = String(req.get?.("idempotency-key") || "").trim();
  if (idempotencyHeader && !input.idempotencyKey) input.idempotencyKey = idempotencyHeader;
  return input;
}

function databaseDisabledResponse(res) {
  return res.status(503).json({
    error: {
      code: "VOLT_CORE_DATABASE_DISABLED",
      message: "VOLT_CORE_APP_DATABASE_URL nao configurada para o runtime persistido.",
    },
  });
}


function pruneDashboardForAccess(user, companyId, dashboard) {
  if (!dashboard) return dashboard;
  const can = (permission) => !permission || runtimeAccess.hasPermission(user, companyId, permission);
  return {
    ...dashboard,
    metrics: (dashboard.metrics || []).filter((item) => can(item.permission)),
    alerts: (dashboard.alerts || []).filter((item) => can(item.permission)),
    operationWidgets: (dashboard.operationWidgets || []).filter((item) => can(item.permission)),
    finance: dashboard.finance && can(dashboard.finance.permission) ? dashboard.finance : null,
    inventory: dashboard.inventory && can(dashboard.inventory.permission) ? dashboard.inventory : null,
    cash: dashboard.cash && can(dashboard.cash.permission) ? dashboard.cash : null,
    salesTrend: can(dashboard.salesTrendPermission) ? (dashboard.salesTrend || []) : [],
    openReceivables: can("receivables:read") ? Number(dashboard.openReceivables || 0) : 0,
    lowStock: can("inventory:read") ? Number(dashboard.lowStock || 0) : 0,
    firstUse: {
      ...(dashboard.firstUse || {}),
      hasProducts: can("products:read") ? Boolean(dashboard.firstUse?.hasProducts) : true,
      hasPositiveStock: can("inventory:read") ? Boolean(dashboard.firstUse?.hasPositiveStock) : true,
      hasOpenCash: can("cash_register:read") ? Boolean(dashboard.firstUse?.hasOpenCash) : true,
      hasSales: can("sales:read") ? Boolean(dashboard.firstUse?.hasSales) : true,
    },
  };
}
function pruneWorkspaceForAccess(req, workspace, accessUser = req.user) {
  const companyId = req.params.companyId;
  const can = (permission) => runtimeAccess.hasPermission(accessUser, companyId, permission);

  if (!can("customers:read")) workspace.customers = [];
  if (!can("products:read")) {
    workspace.products = [];
    workspace.productCategories = [];
    workspace.productBrands = [];
  }
  if (!can("inventory:read")) {
    workspace.stock = [];
    workspace.inventoryMovements = [];
  }
  if (!can("sales:read")) {
    workspace.sales = [];
    workspace.receipts = [];
  }
  if (!can("receivables:read")) workspace.receivables = [];
  if (!can("cash_register:read")) {
    workspace.cashSummary = {};
    workspace.cashMovements = [];
    workspace.cashSessions = [];
  }
  if (!can("expenses:read")) workspace.expenses = [];
  if (!can("service_orders:read")) workspace.serviceOrders = [];
  if (!can("payments:read")) workspace.paymentMethods = [];
  if (!can("users:read")) workspace.users = [];
  if (!can("dashboard:read")) workspace.dashboard = null;
  else workspace.dashboard = pruneDashboardForAccess(accessUser, companyId, workspace.dashboard);

  return workspace;
}

async function resolveOptionalPermissionAccess(req, permissionMap = {}) {
  const companyId = req.params.companyId;
  const role = String(req.user?.role || req.user?.nivel || "").toLowerCase();
  const isMaster = Boolean(req.user?.is_master || req.user?.isMaster || role === "admin_master");
  const entries = Object.entries(permissionMap);
  if (!entries.length) return {};

  if (isMaster) {
    const configuration = await runtime.getCompanyConfiguration(companyId);
    return Object.fromEntries(entries.map(([key, permission]) => [key, isPermissionEnabled(configuration, permission)]));
  }

  const userId = req.user?.uid || req.user?.id;
  const checks = await Promise.all(entries.map(async ([key, permission]) => {
    if (!userId) return [key, false];
    const result = await runtime.checkPermission(companyId, userId, permission);
    return [key, Boolean(result.allowed)];
  }));
  return Object.fromEntries(checks);
}

async function status(_req, res) {
  res.json({
    databaseEnabled: runtime.isEnabled(),
  });
}

async function listCompanies(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    companies: filterCompanies(req, await runtime.listCompanies()),
  });
}

async function getWorkspace(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const companyId = req.params.companyId;
  const workspace = await runtime.getWorkspace(companyId);
  workspace.companies = filterCompanies(req, workspace.companies || []);

  let accessUser = req.user;
  const role = String(req.user?.role || req.user?.nivel || "").toLowerCase();
  const isMaster = Boolean(req.user?.is_master || req.user?.isMaster || role === "admin_master");
  if (!isMaster) {
    const userId = req.user?.uid || req.user?.id;
    const liveAccess = await runtime.getCompanyUserAccess(companyId, userId);
    if (!liveAccess) {
      return res.status(403).json({
        error: { message: "Usuario sem acesso ativo a esta empresa.", code: "COMPANY_ACCESS_REVOKED" },
      });
    }
    accessUser = {
      ...req.user,
      companies: [{ id: companyId, ...liveAccess }],
    };
  }

  if (workspace.configuration?.screens) {
    workspace.configuration.screens = runtimeAccess.getEffectiveScreens(
      accessUser,
      companyId,
      workspace.configuration.screens,
    );
  }
  return res.json({ workspace: pruneWorkspaceForAccess(req, workspace, accessUser) });
}


async function getRuntimeData(req, res, resourceOverride = null) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const resource = resourceOverride || req.params.resource;
  const payload = await runtime.loadRuntimeCollection(req.params.companyId, resource, req.query || {});
  return res.json(payload);
}

async function getRuntimeReports(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const report = await runtime.getReportSummary(req.params.companyId, req.query || {});
  return res.json({ report });
}

async function applySegmentTemplate(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const configuration = await runtime.applySegmentTemplate({
    companyId: req.params.companyId,
    segmentKey: req.body.segmentKey || "general",
    planKey: req.body.planKey || "starter",
    requestedBy: req.user?.uid || req.user?.email || req.body.requestedBy || null,
    name: req.body.name,
    onboarding: { confirmed: true, source: "master_sector_change" },
  });

  return res.json({ configuration });
}

async function selectOnboardingSector(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const role = String(req.user?.role || req.user?.nivel || "").toLowerCase();
  const configuration = await runtime.selectOnboardingSector(req.params.companyId, req.body || {}, {
    userId: req.user?.uid || req.user?.id || null,
    isMaster: Boolean(req.user?.is_master || req.user?.isMaster || role === "admin_master"),
  });
  return res.json({ configuration });
}

async function completeCompanyProfile(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const role = String(req.user?.role || req.user?.nivel || "").toLowerCase();
  const workspace = await runtime.completeCompanyProfile(req.params.companyId, req.body || {}, {
    userId: req.user?.uid || req.user?.id || null,
    isMaster: Boolean(req.user?.is_master || req.user?.isMaster || role === "admin_master"),
  });
  return res.json({ workspace });
}

async function createCompany(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    configuration: await runtime.createCompany(inputWithActor(req), req.user?.uid || req.user?.email),
  });
}

async function createCustomer(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    customer: await runtime.createCustomer(req.params.companyId, inputWithActor(req)),
  });
}

async function getCustomerAccount(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const access = await resolveOptionalPermissionAccess(req, {
    sales: "sales:read",
    receivables: "receivables:read",
    receivablesWrite: "receivables:write",
    cashRegister: "cash_register:read",
    receipts: "receipts:read",
  });
  return res.json({ account: await runtime.getCustomerAccount(req.params.companyId, req.params.customerId, access) });
}

async function getSaleHistory(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const access = await resolveOptionalPermissionAccess(req, {
    inventory: "inventory:read",
    receivables: "receivables:read",
    receipts: "receipts:read",
    cashRegister: "cash_register:read",
    audit: "audit:read",
  });
  return res.json({ history: await runtime.getSaleHistory(req.params.companyId, req.params.saleId, access) });
}

async function updateCustomer(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ customer: await runtime.updateCustomer(req.params.companyId, req.params.customerId, inputWithActor(req)) });
}

async function setCustomerActive(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ customer: await runtime.setCustomerActive(req.params.companyId, req.params.customerId, req.path.endsWith("/activate")) });
}

async function deleteCustomer(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ customer: await runtime.deleteCustomer(req.params.companyId, req.params.customerId) });
}

async function createProductCategory(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    category: await runtime.createProductCategory(req.params.companyId, inputWithActor(req)),
  });
}

async function updateProductCategory(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    category: await runtime.updateProductCategory(req.params.companyId, req.params.categoryId, inputWithActor(req)),
  });
}

async function setProductCategoryActive(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    category: await runtime.setProductCategoryActive(req.params.companyId, req.params.categoryId, req.path.endsWith("/activate")),
  });
}

async function createProductBrand(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    brand: await runtime.createProductBrand(req.params.companyId, inputWithActor(req)),
  });
}

async function updateProductBrand(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    brand: await runtime.updateProductBrand(req.params.companyId, req.params.brandId, inputWithActor(req)),
  });
}

async function setProductBrandActive(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    brand: await runtime.setProductBrandActive(req.params.companyId, req.params.brandId, req.path.endsWith("/activate")),
  });
}

async function createProduct(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    product: await runtime.createProduct(req.params.companyId, inputWithActor(req)),
  });
}

async function updateProduct(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ product: await runtime.updateProduct(req.params.companyId, req.params.productId, inputWithActor(req)) });
}

async function setProductActive(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ product: await runtime.setProductActive(req.params.companyId, req.params.productId, req.path.endsWith("/activate")) });
}

async function deleteProduct(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ product: await runtime.deleteProduct(req.params.companyId, req.params.productId) });
}

async function createInventoryMovement(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    movement: await runtime.createInventoryMovement(req.params.companyId, inputWithActor(req)),
  });
}

async function createSale(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const result = await runtime.createSale(req.params.companyId, inputWithActor(req));
  return res.status(result?.idempotent ? 200 : 201).json(result);
}

async function completeSaleDelivery(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  const result = await runtime.completeSaleDelivery(req.params.companyId, req.params.saleId, inputWithActor(req));
  return res.status(result?.idempotent ? 200 : 201).json(result);
}

async function updateSale(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json(await runtime.updateSale(req.params.companyId, req.params.saleId, inputWithActor(req)));
}

async function cancelSale(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ sale: await runtime.cancelSale(req.params.companyId, req.params.saleId, inputWithActor(req)) });
}

async function deleteCanceledSale(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ sale: await runtime.deleteCanceledSale(req.params.companyId, req.params.saleId, inputWithActor(req)) });
}

async function openCashSession(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    session: await runtime.openCashSession(req.params.companyId, inputWithActor(req)),
  });
}

async function createCashMovement(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    movement: await runtime.createCashMovement(req.params.companyId, inputWithActor(req)),
  });
}

async function createReceivable(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({
    receivable: await runtime.createReceivable(req.params.companyId, inputWithActor(req)),
  });
}

async function receiveReceivable(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    receivable: await runtime.receiveReceivable(req.params.companyId, req.params.receivableId, inputWithActor(req)),
  });
}

async function updateReceivableDueDate(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    receivable: await runtime.updateReceivableDueDate(req.params.companyId, req.params.receivableId, inputWithActor(req)),
  });
}

async function depositCheckReceivable(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    receivable: await runtime.depositCheckReceivable(req.params.companyId, req.params.receivableId, inputWithActor(req)),
  });
}

async function returnCheckReceivable(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    receivable: await runtime.returnCheckReceivable(req.params.companyId, req.params.receivableId, inputWithActor(req)),
  });
}

async function cancelReceivable(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    receivable: await runtime.cancelReceivable(req.params.companyId, req.params.receivableId, inputWithActor(req)),
  });
}

async function updateCompanySettings(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    configuration: await runtime.updateCompanySettings(req.params.companyId, inputWithActor(req)),
  });
}

async function updateCompanyOverrides(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    configuration: await runtime.updateCompanyOverrides(req.params.companyId, inputWithActor(req)),
  });
}

async function closeCashSession(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ session: await runtime.closeCashSession(req.params.companyId, req.params.sessionId, inputWithActor(req)) });
}

async function createExpense(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({ expense: await runtime.createExpense(req.params.companyId, inputWithActor(req)) });
}

async function updateExpense(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ expense: await runtime.updateExpense(req.params.companyId, req.params.expenseId, inputWithActor(req)) });
}

async function cancelExpense(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ expense: await runtime.cancelExpense(req.params.companyId, req.params.expenseId, inputWithActor(req)) });
}

async function payExpense(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ expense: await runtime.payExpense(req.params.companyId, req.params.expenseId, inputWithActor(req)) });
}

async function createServiceOrder(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({ serviceOrder: await runtime.createServiceOrder(req.params.companyId, inputWithActor(req)) });
}

async function updateServiceOrder(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ serviceOrder: await runtime.updateServiceOrder(req.params.companyId, req.params.serviceOrderId, inputWithActor(req)) });
}

async function savePaymentMethod(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ paymentMethod: await runtime.savePaymentMethod(req.params.companyId, inputWithActor(req)) });
}

async function createUser(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(201).json({ user: await runtime.createCompanyUser(req.params.companyId, inputWithActor(req)) });
}

async function updateUser(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ user: await runtime.updateCompanyUser(req.params.companyId, req.params.userId, inputWithActor(req)) });
}


async function getCommercialProducts(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ commercial: await runtime.getCompanyCommercialSnapshot(req.params.companyId) });
}

async function requestCommercialProduct(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.status(202).json({
    commercial: await runtime.requestCommercialProduct(req.params.companyId, req.params.productKey, inputWithActor(req)),
  });
}

async function setCommercialProduct(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({
    commercial: await runtime.setCommercialProduct(req.params.companyId, req.params.productKey, inputWithActor(req)),
  });
}

async function saveConfigurationItem(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ item: await runtime.saveConfigurationItem(req.params.companyId, req.params.listKey, inputWithActor(req)) });
}

async function deleteConfigurationItem(req, res) {
  if (!runtime.isEnabled()) return databaseDisabledResponse(res);
  return res.json({ item: await runtime.deleteConfigurationItem(req.params.companyId, req.params.listKey, req.params.itemId, inputWithActor(req)) });
}

module.exports = {
  getCommercialProducts,
  getCustomerAccount,
  getSaleHistory,
  getRuntimeData,
  getRuntimeReports,
  applySegmentTemplate,
  cancelReceivable,
  cancelExpense,
  cancelSale,
  closeCashSession,
  completeSaleDelivery,
  completeCompanyProfile,
  createCashMovement,
  createCompany,
  createCustomer,
  createExpense,
  createInventoryMovement,
  createProduct,
  createProductBrand,
  createProductCategory,
  createReceivable,
  createSale,
  createServiceOrder,
  createUser,
  deleteConfigurationItem,
  deleteCustomer,
  deleteCanceledSale,
  deleteProduct,
  depositCheckReceivable,
  getWorkspace,
  listCompanies,
  openCashSession,
  payExpense,
  receiveReceivable,
  requestCommercialProduct,
  returnCheckReceivable,
  saveConfigurationItem,
  savePaymentMethod,
  selectOnboardingSector,
  status,
  setCommercialProduct,
  setCustomerActive,
  setProductActive,
  setProductBrandActive,
  setProductCategoryActive,
  updateCustomer,
  updateCompanyOverrides,
  updateCompanySettings,
  updateExpense,
  updateReceivableDueDate,
  updateProduct,
  updateProductBrand,
  updateProductCategory,
  updateSale,
  updateServiceOrder,
  updateUser,
};
