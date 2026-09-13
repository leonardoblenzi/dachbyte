"use strict";

const runtimeResources = require("./backend/runtimeResources");
const { registerFiscalRoutes } = require("./backend/routes");
const saleHooks = require("./backend/saleHooks");
const entityHooks = require("./backend/entityHooks");

module.exports = Object.freeze({
  key: "service.fiscal",
  kind: "service",
  version: "1.0.0",
  activationCapability: "service.fiscal",
  capabilities: ["fiscal.documents", "service.fiscal.active"],
  access: {
    permissions: [
      { key: "fiscal:read", label: "Visualizar documentos fiscais", moduleKey: "fiscal", module: "Fiscal" },
      { key: "fiscal:write", label: "Gerenciar documentos fiscais", moduleKey: "fiscal", module: "Fiscal" },
    ],
    rolePresets: {
      manager: { permissions: ["fiscal:read", "fiscal:write"], screens: ["fiscal"] },
      finance: { permissions: ["fiscal:read"], screens: ["fiscal"] },
    },
  },
  contributions: {
    runtimeResources: ["fiscal_documents"],
    domainHooks: ["sale.beforeDeleteCanceled", "customer.dependencies"],
    uiSlots: ["product.form.fiscal", "sale.detail.actions"],
  },
  backend: {
    runtimeResources,
    registerRoutes: registerFiscalRoutes,
    hooks: {
      "sale.beforeDeleteCanceled": { handler: saleHooks.beforeDeleteCanceledSale, runWhenDisabled: true },
      "customer.dependencies": { handler: entityHooks.customerDependencies, runWhenDisabled: true },
    },
  },
});
