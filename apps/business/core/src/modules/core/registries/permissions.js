"use strict";

const ALL = "*";

const permissions = Object.freeze([
  { key: ALL, label: "Acesso total", moduleKey: "companies", module: "Sistema" },
  { key: "dashboard:read", label: "Visualizar dashboard", moduleKey: "reports", module: "Dashboard" },
  { key: "customers:read", label: "Visualizar clientes", moduleKey: "customers", module: "Clientes" },
  { key: "customers:write", label: "Cadastrar e editar clientes", moduleKey: "customers", module: "Clientes" },
  { key: "products:read", label: "Visualizar produtos", moduleKey: "products", module: "Produtos" },
  { key: "products:write", label: "Cadastrar e editar produtos", moduleKey: "products", module: "Produtos" },
  { key: "inventory:read", label: "Visualizar estoque", moduleKey: "inventory", module: "Estoque" },
  { key: "inventory:write", label: "Movimentar estoque", moduleKey: "inventory", module: "Estoque" },
  { key: "sales:read", label: "Visualizar vendas", moduleKey: "sales", module: "Vendas" },
  { key: "sales:write", label: "Criar e cancelar vendas", moduleKey: "sales", module: "Vendas" },
  { key: "payments:read", label: "Visualizar pagamentos", moduleKey: "payments", module: "Pagamentos" },
  { key: "payments:write", label: "Configurar pagamentos", moduleKey: "payments", module: "Pagamentos" },
  { key: "receivables:read", label: "Visualizar recebiveis", moduleKey: "receivables", module: "Recebiveis" },
  { key: "receivables:write", label: "Gerenciar recebiveis", moduleKey: "receivables", module: "Recebiveis" },
  { key: "cash_register:read", label: "Visualizar caixa", moduleKey: "cash_register", module: "Caixa" },
  { key: "cash_register:write", label: "Operar caixa", moduleKey: "cash_register", module: "Caixa" },
  { key: "receipts:read", label: "Visualizar recibos", moduleKey: "receipts", module: "Recibos" },
  { key: "expenses:read", label: "Visualizar despesas", moduleKey: "finance", module: "Financeiro" },
  { key: "expenses:write", label: "Gerenciar despesas", moduleKey: "finance", module: "Financeiro" },
  { key: "reports:read", label: "Visualizar relatorios", moduleKey: "reports", module: "Relatorios" },
  { key: "reports:export", label: "Exportar relatorios", moduleKey: "reports", module: "Relatorios" },
  { key: "settings:read", label: "Visualizar configuracoes", moduleKey: "companies", module: "Configuracoes" },
  { key: "settings:write", label: "Alterar configuracoes", moduleKey: "companies", module: "Configuracoes" },
  { key: "services:read", label: "Visualizar Servicos Volt", moduleKey: "companies", module: "Servicos Volt" },
  { key: "services:write", label: "Solicitar Servicos Volt", moduleKey: "companies", module: "Servicos Volt" },
  { key: "users:read", label: "Visualizar usuarios", moduleKey: "users", module: "Usuarios" },
  { key: "users:write", label: "Gerenciar usuarios", moduleKey: "users", module: "Usuarios" },
  { key: "companies:write", label: "Gerenciar empresas", moduleKey: "companies", module: "Empresas" },
  { key: "service_orders:read", label: "Visualizar ordens de servico", moduleKey: "service_orders", module: "Ordens de servico" },
  { key: "service_orders:write", label: "Gerenciar ordens de servico", moduleKey: "service_orders", module: "Ordens de servico" },
  { key: "imports:write", label: "Importar dados", moduleKey: "companies", module: "Importacao" },
  { key: "audit:read", label: "Consultar auditoria", moduleKey: "reports", module: "Auditoria" },
  { key: "integrations:read", label: "Visualizar integracoes e filas", moduleKey: "integrations", module: "Integracoes" },
  { key: "integrations:write", label: "Gerenciar integracoes e retries", moduleKey: "integrations", module: "Integracoes" },
]);

const permissionByKey = Object.freeze(Object.fromEntries(permissions.map((permission) => [permission.key, permission])));

const rolePresets = Object.freeze({
  admin: { permissions: [ALL], screens: [ALL] },
  owner: { permissions: [ALL], screens: [ALL] },
  manager: {
    permissions: [
      "dashboard:read", "customers:read", "customers:write", "products:read", "products:write",
      "inventory:read", "inventory:write", "sales:read", "sales:write", "payments:read", "payments:write",
      "receivables:read", "receivables:write", "cash_register:read", "cash_register:write", "receipts:read",
      "expenses:read", "expenses:write", "reports:read", "reports:export", "imports:write", "settings:read",
      "settings:write", "services:read", "service_orders:read", "service_orders:write",
    ],
    screens: [
      "dashboard", "sales", "customers", "products", "inventory", "payments", "receivables", "cash_register",
      "receipts", "finance", "reports", "settings", "services", "service_orders",
    ],
  },
  operator: {
    permissions: [
      "dashboard:read", "customers:read", "customers:write", "products:read", "inventory:read", "sales:read",
      "sales:write", "payments:read", "receivables:read", "cash_register:read", "cash_register:write",
      "receipts:read", "reports:read", "service_orders:read",
    ],
    screens: [
      "dashboard", "sales", "customers", "products", "inventory", "receivables", "cash_register", "receipts",
      "reports", "service_orders",
    ],
  },
  stock: {
    permissions: ["dashboard:read", "products:read", "products:write", "inventory:read", "inventory:write", "reports:read", "reports:export"],
    screens: ["dashboard", "products", "inventory", "reports"],
  },
  finance: {
    permissions: [
      "dashboard:read", "payments:read", "receivables:read", "receivables:write", "cash_register:read",
      "cash_register:write", "receipts:read", "expenses:read", "expenses:write", "reports:read", "reports:export",
      "audit:read",
    ],
    screens: ["dashboard", "payments", "receivables", "cash_register", "receipts", "finance", "reports"],
  },
});

function getPermission(permissionKey) {
  return permissionByKey[String(permissionKey || "").trim()] || null;
}

module.exports = {
  ALL,
  getPermission,
  permissions,
  rolePresets,
};
