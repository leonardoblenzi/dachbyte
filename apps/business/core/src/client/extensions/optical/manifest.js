import { mapOpticalWorkspace } from "./workspaceMapper";
import { contributeOpticalModalConfig } from "./modalConfig";
const opticalManifest = Object.freeze({
  key: "vertical.optical",
  kind: "vertical",
  activationCapability: "vertical.optical",
  runtimeResources: Object.freeze({
    prescriptions: Object.freeze({ path: "prescriptions", capability: "optical.prescriptions", paged: true }),
    opticalOrders: Object.freeze({ path: "optical-orders", capability: "optical.orders", paged: true }),
    opticalLaboratories: Object.freeze({ path: "optical-laboratories", capability: "optical.laboratories" }),
  }),
  pageResources: Object.freeze({
    sales: Object.freeze(["prescriptions"]),
    customers: Object.freeze(["prescriptions", "opticalOrders", "serviceOrders"]),
    optical_prescriptions: Object.freeze(["prescriptions", "opticalOrders", "opticalLaboratories", "customers"]),
  }),
  productFilters: Object.freeze(["Armacao", "Lente em estoque", "Lente encomendada", "Acessorio"]),
  productImport: Object.freeze({
    columns: Object.freeze([{ key: "item_otico", label: "item_otico" }]),
    classifications: Object.freeze(["Armacao", "Lente em estoque", "Lente encomendada", "Servico", "Acessorio"]),
  }),
  normalizeProductImportRow(row = {}) {
    const value = String(row.itemKind || row.item_otico || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const itemKind = value.includes("armac") ? "frame"
      : value.includes("encomend") ? "lens_order"
        : value.includes("lente") ? "lens_stock"
          : value.includes("acessor") ? "accessory"
            : value.includes("serv") ? "service"
              : "";
    return itemKind ? { itemKind } : {};
  },
  serviceOrderFilters: Object.freeze([
    { value: "awaiting_prescription", label: "Aguardando receita" },
    { value: "awaiting_measurements", label: "Aguardando medidas" },
    { value: "awaiting_lab", label: "Aguardando laboratorio" },
    { value: "ready_for_production", label: "Pronto para producao" },
    { value: "sent_to_lab", label: "Enviado ao laboratorio" },
    { value: "received_from_lab", label: "Recebido do laboratorio" },
    { value: "quality_check", label: "Conferencia" },
    { value: "rework", label: "Retrabalho" },
  ]),
  accessAreas: Object.freeze([{ screen: "optical_prescriptions", label: "Receitas opticas", read: "optical_prescriptions:read", write: "optical_prescriptions:write" }]),
  rolePermissions: Object.freeze({
    manager: Object.freeze(["optical_prescriptions:read", "optical_prescriptions:write"]),
    operator: Object.freeze(["optical_prescriptions:read"]),
  }),
  slots: Object.freeze({
    "sales.pdv": Object.freeze([{ id: "optical-pdv", label: "Nova venda", capability: "optical.sales_pdv", load: () => import("./OpticalSalesPdv.jsx") }]),
    "customer.detail.tabs": Object.freeze([{ id: "optical", label: "Otica", icon: "glasses", load: () => import("./CustomerExtension.jsx"), exportName: "CustomerOpticalPanel" }]),
    "customer.detail.actions": Object.freeze([{ id: "new-prescription", label: "Nova receita", actionType: "prescription", style: "primary" }]),
    "customer.summary.cards": Object.freeze([{ id: "optical-prescription-card", load: () => import("./CustomerExtension.jsx"), exportName: "CustomerOpticalSummaryCard" }]),
    "customer.history.sections": Object.freeze([{ id: "optical-history", load: () => import("./CustomerExtension.jsx"), exportName: "CustomerOpticalHistorySection" }]),
    "service_orders.production": Object.freeze([{ id: "optical-production", load: () => import("./ServiceOrderProductionExtension.jsx") }]),
  }),
  nav: Object.freeze({ group: "vertical", id: "optical_prescriptions", name: "Otica", icon: "glasses", capability: "vertical.optical" }),
  pages: Object.freeze({
    optical_prescriptions: Object.freeze({
      capability: "vertical.optical",
      readPermission: "optical_prescriptions:read",
      title: "Receitas opticas",
      description: "Receita, medidas, laboratorio e vinculo com OS.",
      load: () => import("./OpticalPrescriptionsPage.jsx"),
    }),
  }),
  mapWorkspace: mapOpticalWorkspace,
  contributeModalConfig: contributeOpticalModalConfig,
  async loadSubmitHandlers() {
    const module = await import("./handlers.js");
    return module.createOpticalSubmitHandlers;
  },
  async buildPayload(scope, values) {
    if (scope !== "product") return null;
    const module = await import("./productPayload.js");
    return module.buildOpticalProductExtensionPayload(values);
  },
});

export default opticalManifest;
