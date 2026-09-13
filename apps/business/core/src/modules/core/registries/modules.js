"use strict";

const modules = Object.freeze([
  { key: "companies", name: "Empresas", layer: "core", required: true, dependencies: [], capabilities: ["companies.settings", "companies.imports"] },
  { key: "users", name: "Usuarios e permissoes", layer: "core", required: true, dependencies: ["companies"], capabilities: ["users.manage"] },
  { key: "integrations", name: "Motor de integracoes", layer: "core", required: true, dependencies: ["companies"], capabilities: ["integrations.engine"] },
  { key: "customers", name: "Clientes", layer: "functional", required: false, dependencies: ["companies"], capabilities: ["customers.manage"] },
  { key: "products", name: "Produtos e servicos", layer: "functional", required: false, dependencies: ["companies"], capabilities: ["catalog.products"] },
  { key: "inventory", name: "Estoque", layer: "functional", required: false, dependencies: ["products"], capabilities: ["inventory.manage"] },
  { key: "sales", name: "Vendas", layer: "functional", required: false, dependencies: ["customers", "products"], capabilities: ["sales.manage"] },
  { key: "payments", name: "Pagamentos", layer: "functional", required: false, dependencies: ["sales"], capabilities: ["payments.configure"] },
  { key: "receivables", name: "Contas a receber", layer: "functional", required: false, dependencies: ["customers", "sales"], capabilities: ["receivables.manage"] },
  { key: "receipts", name: "Recibos", layer: "functional", required: false, dependencies: ["sales"], capabilities: ["receipts.read"] },
  { key: "service_orders", name: "Ordem de servico", layer: "functional", required: false, dependencies: ["customers"], capabilities: ["service_orders.manage"] },
  { key: "reports", name: "Relatorios", layer: "functional", required: false, dependencies: ["companies"], capabilities: ["reports.read", "audit.read"] },
  { key: "cash_register", name: "Caixa", layer: "functional", required: false, dependencies: ["payments"], capabilities: ["cash_register.manage"] },
  { key: "finance", name: "Financeiro", layer: "functional", required: false, dependencies: ["receivables", "cash_register"], capabilities: ["finance.expenses"] },
  { key: "fiscal", name: "Emissor Fiscal", layer: "service", required: false, dependencies: ["sales"], capabilities: ["fiscal.documents"] },
  {
    key: "optical_prescriptions",
    name: "Otica",
    layer: "segment",
    required: false,
    dependencies: ["customers", "products", "sales", "service_orders"],
    capabilities: ["optical.prescriptions", "optical.laboratories", "optical.orders", "optical.sales_pdv", "optical.catalog"],
  },
]);

module.exports = { modules };
