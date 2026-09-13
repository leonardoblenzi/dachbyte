import { fallbackPermissionsForRole, hasCompanyCapability, normalizeUiRole } from "../core/access";
import opticalManifest from "./optical/manifest";
import fiscalManifest from "./fiscal/manifest";

const CORE_RUNTIME_RESOURCES = Object.freeze({
  customers: Object.freeze({ path: "customers", paged: true }),
  products: Object.freeze({ path: "products", paged: true }),
  productCategories: Object.freeze({ path: "product-categories" }),
  productBrands: Object.freeze({ path: "product-brands" }),
  sales: Object.freeze({ path: "sales", paged: true }),
  receivables: Object.freeze({ path: "receivables", paged: true }),
  inventoryMovements: Object.freeze({ path: "inventory-movements", paged: true }),
  stockReservations: Object.freeze({ path: "stock-reservations", paged: true }),
  cashMovements: Object.freeze({ path: "cash-movements", paged: true }),
  cashSessions: Object.freeze({ path: "cash-sessions", paged: true }),
  receipts: Object.freeze({ path: "receipts", paged: true }),
  expenses: Object.freeze({ path: "expenses", paged: true }),
  serviceOrders: Object.freeze({ path: "service-orders", paged: true }),
  paymentMethods: Object.freeze({ path: "payment-methods" }),
  users: Object.freeze({ path: "users", paged: true }),
  auditLogs: Object.freeze({ path: "audit-logs", paged: true }),
});

const CORE_PAGE_RUNTIME_RESOURCES = Object.freeze({
  sales: Object.freeze(["sales", "products", "customers", "paymentMethods"]),
  customers: Object.freeze(["customers"]),
  products: Object.freeze(["products", "productCategories", "productBrands"]),
  inventory: Object.freeze(["products", "inventoryMovements", "stockReservations"]),
  payments: Object.freeze(["paymentMethods", "receivables"]),
  receivables: Object.freeze(["receivables"]),
  cash_register: Object.freeze(["cashMovements", "cashSessions"]),
  receipts: Object.freeze(["receipts"]),
  finance: Object.freeze(["expenses", "receivables"]),
  service_orders: Object.freeze(["serviceOrders", "customers"]),
  users: Object.freeze(["users", "auditLogs"]),
});

const CLIENT_EXTENSIONS = Object.freeze([opticalManifest, fiscalManifest]);

function extensionEnabled(extension, configuration) {
  return !extension.activationCapability || hasCompanyCapability(configuration, extension.activationCapability);
}

function enabledClientExtensions(configuration) {
  return CLIENT_EXTENSIONS.filter((extension) => extensionEnabled(extension, configuration));
}

function resolveExtensionResource(resource, configuration) {
  for (const extension of enabledClientExtensions(configuration)) {
    const definition = extension.runtimeResources?.[resource];
    if (!definition) continue;
    if (definition.capability && !hasCompanyCapability(configuration, definition.capability)) return null;
    return { ...definition, extensionKey: extension.key, kind: extension.kind };
  }
  return null;
}

function resolveRuntimeResource(resource, configuration) {
  const core = CORE_RUNTIME_RESOURCES[resource];
  if (core) return { ...core, extensionKey: null, kind: "core" };
  return resolveExtensionResource(resource, configuration);
}

function isRuntimeResourceAvailable(resource, configuration) {
  return Boolean(resolveRuntimeResource(resource, configuration));
}

function isPagedRuntimeResource(resource, configuration) {
  return Boolean(resolveRuntimeResource(resource, configuration)?.paged);
}

function resolvePageRuntimeResources(pageId, configuration) {
  const resources = [...(CORE_PAGE_RUNTIME_RESOURCES[pageId] || [])];
  for (const extension of enabledClientExtensions(configuration)) {
    for (const resource of extension.pageResources?.[pageId] || []) {
      if (resolveRuntimeResource(resource, configuration)) resources.push(resource);
    }
  }
  return [...new Set(resources)];
}

async function loadExtensionSubmitHandlers(context) {
  const configuration = context?.workspace?.configuration || {};
  const handlers = {};
  for (const extension of enabledClientExtensions(configuration)) {
    if (typeof extension.loadSubmitHandlers !== "function") continue;
    const factory = await extension.loadSubmitHandlers();
    Object.assign(handlers, factory(context));
  }
  return handlers;
}

async function buildExtensionPayloads(scope, values, configuration) {
  const extensions = {};
  for (const extension of enabledClientExtensions(configuration || {})) {
    if (typeof extension.buildPayload !== "function") continue;
    const payload = await extension.buildPayload(scope, values);
    if (payload && Object.keys(payload).length) extensions[extension.key] = payload;
  }
  return Object.keys(extensions).length ? extensions : null;
}

function applyExtensionWorkspaceMappings(workspace, current) {
  let next = current;
  const configuration = workspace?.configuration || {};
  for (const extension of enabledClientExtensions(configuration)) {
    if (typeof extension.mapWorkspace !== "function") continue;
    next = extension.mapWorkspace(workspace, next) || next;
  }
  return next;
}

function applyExtensionModalContributions(type, baseConfig, context, configuration) {
  let result = baseConfig || null;
  for (const extension of enabledClientExtensions(configuration || {})) {
    if (typeof extension.contributeModalConfig !== "function") continue;
    result = extension.contributeModalConfig(type, result, context) || result;
  }
  return result;
}

function extensionProductFilters(configuration) {
  return [...new Set(enabledClientExtensions(configuration || {}).flatMap((extension) => extension.productFilters || []))];
}

function extensionProductImportSchema(configuration) {
  const schemas = enabledClientExtensions(configuration || {}).map((extension) => extension.productImport).filter(Boolean);
  return {
    columns: schemas.flatMap((schema) => schema.columns || []),
    classifications: schemas.flatMap((schema) => schema.classifications || []),
  };
}

function normalizeExtensionProductImportValues(row, configuration) {
  let values = {};
  for (const extension of enabledClientExtensions(configuration || {})) {
    if (typeof extension.normalizeProductImportRow !== "function") continue;
    values = { ...values, ...(extension.normalizeProductImportRow(row) || {}) };
  }
  return values;
}

function extensionServiceOrderFilters(configuration) {
  const seen = new Set();
  return enabledClientExtensions(configuration || {}).flatMap((extension) => extension.serviceOrderFilters || []).filter((item) => {
    const key = String(item?.value || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extensionAccessAreas(configuration) {
  return enabledClientExtensions(configuration || {}).flatMap((extension) => extension.accessAreas || []);
}

function fallbackPermissionsForRoleWithExtensions(role, configuration) {
  const base = fallbackPermissionsForRole(role);
  if (base.includes("*")) return base;
  const normalizedRole = normalizeUiRole(role);
  const extensionPermissions = enabledClientExtensions(configuration || {})
    .flatMap((extension) => extension.rolePermissions?.[normalizedRole] || []);
  return [...new Set([...base, ...extensionPermissions])];
}

async function loadExtensionPageComponent(pageId, configuration) {
  const page = resolveExtensionPage(pageId, configuration);
  if (!page || typeof page.load !== "function") return null;
  const module = await page.load();
  return module.default || module.Page || null;
}

function listExtensionSlots(slot, configuration) {
  const key = String(slot || "").trim();
  if (!key) return [];
  return enabledClientExtensions(configuration || {}).flatMap((extension) =>
    (extension.slots?.[key] || [])
      .filter((definition) => !definition.capability || hasCompanyCapability(configuration, definition.capability))
      .map((definition) => ({
        ...definition,
        extensionKey: extension.key,
        extensionKind: extension.kind,
        slot: key,
      })),
  );
}

async function loadExtensionSlotComponent(extensionKey, slot, contributionId, configuration) {
  const extension = enabledClientExtensions(configuration || {}).find((item) => item.key === extensionKey);
  if (!extension) return null;
  const contribution = (extension.slots?.[slot] || []).find((item) => item.id === contributionId);
  if (!contribution || typeof contribution.load !== "function") return null;
  const module = await contribution.load();
  return contribution.exportName ? module[contribution.exportName] : (module.default || null);
}

function listClientExtensions() {
  return [...CLIENT_EXTENSIONS];
}

function listEnabledExtensionNavigation(configuration) {
  return enabledClientExtensions(configuration)
    .map((extension) => extension.nav)
    .filter(Boolean)
    .filter((item) => !item.capability || hasCompanyCapability(configuration, item.capability));
}

function resolveExtensionPage(pageId, configuration) {
  for (const extension of enabledClientExtensions(configuration)) {
    const page = extension.pages?.[pageId];
    if (!page) continue;
    if (page.capability && !hasCompanyCapability(configuration, page.capability)) return null;
    return { ...page, extensionKey: extension.key };
  }
  return null;
}

export {
  CORE_PAGE_RUNTIME_RESOURCES,
  CORE_RUNTIME_RESOURCES,
  applyExtensionModalContributions,
  applyExtensionWorkspaceMappings,
  buildExtensionPayloads,
  enabledClientExtensions,
  extensionAccessAreas,
  fallbackPermissionsForRoleWithExtensions,
  extensionProductFilters,
  extensionProductImportSchema,
  extensionServiceOrderFilters,
  isPagedRuntimeResource,
  isRuntimeResourceAvailable,
  listClientExtensions,
  listExtensionSlots,
  listEnabledExtensionNavigation,
  loadExtensionPageComponent,
  loadExtensionSlotComponent,
  loadExtensionSubmitHandlers,
  normalizeExtensionProductImportValues,
  resolveExtensionPage,
  resolvePageRuntimeResources,
  resolveRuntimeResource,
};
