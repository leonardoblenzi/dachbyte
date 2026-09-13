const { workflows } = require("../workflows/workflowRegistry");

const defaultModules = [
  "companies",
  "users",
  "customers",
  "products",
  "inventory",
  "sales",
  "payments",
  "receivables",
  "cash_register",
  "receipts",
  "finance",
  "reports",
];

const defaultScreens = [
  "dashboard",
  "sales",
  "customers",
  "products",
  "inventory",
  "payments",
  "receivables",
  "cash_register",
  "receipts",
  "finance",
  "reports",
  "services",
  "settings",
  "users",
];

const defaultCategories = [
  "Produtos",
  "Servicos",
  "Acessorios",
];

const defaultStatuses = [
  "orcamento",
  "vendido",
  "cancelado",
];

const defaultFields = [
  { entity: "customer", key: "name", label: "Nome", type: "text", required: true },
  { entity: "customer", key: "phone", label: "Telefone/WhatsApp", type: "text", required: false },
  { entity: "customer", key: "document", label: "CPF/CNPJ", type: "text", required: false },
  { entity: "product", key: "sku", label: "SKU/Codigo", type: "text", required: false },
  { entity: "product", key: "name", label: "Nome", type: "text", required: true },
  { entity: "product", key: "salePrice", label: "Preco de venda", type: "money", required: true },
  { entity: "product", key: "costPrice", label: "Custo", type: "money", required: false },
  { entity: "product", key: "minimumStock", label: "Estoque minimo", type: "number", required: false },
];

const defaultWorkflows = [workflows.service_order];

const defaultRoles = [
  {
    key: "owner",
    name: "Dono/Admin",
    permissions: ["*"],
  },
  {
    key: "seller",
    name: "Vendedor",
    permissions: [
      "customers:read",
      "customers:write",
      "products:read",
      "inventory:read",
      "sales:read",
      "sales:write",
      "cash_register:read",
      "receipts:read",
      "reports:read",
    ],
  },
  {
    key: "stock",
    name: "Estoque",
    permissions: [
      "products:read",
      "products:write",
      "inventory:read",
      "inventory:write",
      "reports:read",
    ],
  },
];

module.exports = {
  segmentKey: "general",
  name: "Empresa padrao",
  description: "Core padrao para vendas, estoque, caixa e relatorios.",
  defaultModules,
  defaultScreens,
  defaultCategories,
  defaultStatuses,
  defaultFields,
  defaultCustomFields: [],
  defaultWorkflows,
  defaultRoles,
};
