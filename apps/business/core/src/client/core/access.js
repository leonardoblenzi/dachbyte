function splitAccessList(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUiRole(value) {
  const role = String(value || "operator").trim().toLowerCase();
  if (["admin_master", "master", "owner", "dono", "admin", "administrador"].includes(role)) return "owner";
  if (["gerente", "manager"].includes(role)) return "manager";
  if (["estoque", "stock"].includes(role)) return "stock";
  if (["financeiro", "finance"].includes(role)) return "finance";
  return "operator";
}

function fallbackPermissionsForRole(role) {
  switch (normalizeUiRole(role)) {
    case "owner":
      return ["*"];
    case "manager":
      return [
        "dashboard:read",
        "customers:read",
        "customers:write",
        "products:read",
        "products:write",
        "inventory:read",
        "inventory:write",
        "sales:read",
        "sales:write",
        "payments:read",
        "payments:write",
        "receivables:read",
        "receivables:write",
        "cash_register:read",
        "cash_register:write",
        "receipts:read",
        "expenses:read",
        "expenses:write",
        "reports:read",
        "settings:read",
        "settings:write",
        "services:read",
        "service_orders:read",
        "service_orders:write",
      ];
    case "finance":
      return [
        "dashboard:read",
        "payments:read",
        "receivables:read",
        "receivables:write",
        "cash_register:read",
        "cash_register:write",
        "receipts:read",
        "expenses:read",
        "expenses:write",
        "reports:read",
        "audit:read",
      ];
    case "stock":
      return ["dashboard:read", "products:read", "products:write", "inventory:read", "inventory:write", "reports:read"];
    default:
      return [
        "dashboard:read",
        "customers:read",
        "customers:write",
        "products:read",
        "inventory:read",
        "sales:read",
        "sales:write",
        "payments:read",
        "receivables:read",
        "cash_register:read",
        "cash_register:write",
        "receipts:read",
        "reports:read",
        "service_orders:read",
      ];
  }
}

function hasCompanyCapability(configuration, capability) {
  const capabilities = Array.isArray(configuration?.capabilities) ? configuration.capabilities : [];
  return capabilities.includes(capability);
}

export {
  fallbackPermissionsForRole,
  hasCompanyCapability,
  normalizeUiRole,
  splitAccessList,
};
