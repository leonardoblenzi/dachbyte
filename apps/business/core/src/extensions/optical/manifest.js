"use strict";

const runtimeResources = require("./backend/runtimeResources");
const { registerOpticalRoutes } = require("./backend/routes");
const saleHooks = require("./backend/saleHooks");
const productHooks = require("./backend/productHooks");
const entityHooks = require("./backend/entityHooks");

module.exports = Object.freeze({
  key: "vertical.optical",
  kind: "vertical",
  version: "1.0.0",
  activationCapability: "vertical.optical",
  capabilities: [
    "optical.catalog",
    "optical.prescriptions",
    "optical.laboratories",
    "optical.orders",
    "optical.sales_pdv",
  ],
  access: {
    permissions: [
      { key: "optical_prescriptions:read", label: "Visualizar receitas opticas", moduleKey: "optical_prescriptions", module: "Otica" },
      { key: "optical_prescriptions:write", label: "Gerenciar receitas opticas", moduleKey: "optical_prescriptions", module: "Otica" },
    ],
    rolePresets: {
      manager: { permissions: ["optical_prescriptions:read", "optical_prescriptions:write"], screens: ["optical_prescriptions"] },
      operator: { permissions: ["optical_prescriptions:read"], screens: ["optical_prescriptions"] },
    },
  },
  input: {
    sale: {
      capability: "optical.sales_pdv",
      legacyKeys: ["optical"],
    },
    product: {
      capability: "optical.catalog",
      extract(input = {}) {
        return { opticalType: input.opticalType || null, opticalSpecs: input.opticalSpecs || {}, catalogType: input.catalogType || null };
      },
    },
  },
  contributions: {
    runtimeResources: ["prescriptions", "optical_orders", "optical_laboratories"],
    domainHooks: ["sale.afterCreated", "sale.afterDeliveryCompleted", "sale.decorateIdempotent", "sale.beforeCanceled", "sale.beforeUpdated", "sale.beforeDeleteCanceled", "sale.decorateRows", "sale.resolveListFilter", "product.afterPersisted", "product.decorateRows", "product.dependencies", "product.beforeDeleted", "customer.dependencies", "dashboard.contribute", "serviceOrder.decorateRows", "serviceOrder.resolveWorkflow"],
    uiSlots: ["product.form.extra", "sales.pdv", "customer.detail", "dashboard.alerts"],
  },
  backend: {
    runtimeResources,
    registerRoutes: registerOpticalRoutes,
    hooks: {
      "sale.afterCreated": saleHooks.afterSaleCreated,
      "sale.afterDeliveryCompleted": saleHooks.afterDeliveryCompleted,
      "sale.decorateIdempotent": { handler: saleHooks.decorateIdempotentResult, runWhenDisabled: true },
      "sale.beforeCanceled": { handler: saleHooks.beforeSaleCanceled, runWhenDisabled: true },
      "sale.beforeUpdated": { handler: saleHooks.beforeSaleUpdated, runWhenDisabled: true },
      "sale.beforeDeleteCanceled": { handler: saleHooks.beforeDeleteCanceledSale, runWhenDisabled: true },
      "sale.decorateRows": saleHooks.decorateSaleRows,
      "sale.resolveListFilter": saleHooks.resolveSaleListFilter,
      "product.afterPersisted": productHooks.afterPersisted,
      "product.decorateRows": productHooks.decorateRows,
      "product.dependencies": { handler: productHooks.dependencies, runWhenDisabled: true },
      "product.beforeDeleted": { handler: productHooks.beforeDeleted, runWhenDisabled: true },
      "customer.dependencies": { handler: entityHooks.customerDependencies, runWhenDisabled: true },
      "dashboard.contribute": entityHooks.dashboardContribute,
      "serviceOrder.decorateRows": entityHooks.decorateServiceOrders,
      "serviceOrder.resolveWorkflow": { handler: entityHooks.resolveServiceOrderWorkflow, runWhenDisabled: true },
    },
  },
});
