const screens = [
  { key: "dashboard", name: "Dashboard", moduleKey: "reports" },
  { key: "sales", name: "Vendas", moduleKey: "sales" },
  { key: "customers", name: "Clientes", moduleKey: "customers" },
  { key: "products", name: "Produtos", moduleKey: "products" },
  { key: "inventory", name: "Estoque", moduleKey: "inventory" },
  { key: "payments", name: "Pagamentos", moduleKey: "payments" },
  { key: "receivables", name: "Contas a receber", moduleKey: "receivables" },
  { key: "cash_register", name: "Caixa", moduleKey: "cash_register" },
  { key: "receipts", name: "Recibos", moduleKey: "receipts" },
  { key: "finance", name: "Financeiro", moduleKey: "finance" },
  { key: "fiscal", name: "Emissor Fiscal", moduleKey: "fiscal" },
  { key: "service_orders", name: "Ordens de servico", moduleKey: "service_orders" },
  { key: "optical_prescriptions", name: "Receitas opticas", moduleKey: "optical_prescriptions" },
  { key: "reports", name: "Relatorios", moduleKey: "reports" },
  { key: "services", name: "Servicos Volt", moduleKey: "companies" },
  { key: "settings", name: "Configuracoes", moduleKey: "companies" },
  { key: "users", name: "Usuarios", moduleKey: "users" },
  { key: "master_companies", name: "Empresas", moduleKey: "companies", masterOnly: true },
  { key: "master_modules", name: "Modulos", moduleKey: "companies", masterOnly: true },
];

module.exports = {
  screens,
};
