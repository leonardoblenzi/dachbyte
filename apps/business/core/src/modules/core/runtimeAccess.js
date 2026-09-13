const { ALL, permissions: CORE_PERMISSIONS, rolePresets: ROLE_PRESETS } = require("./registries/permissions");
const { extensionRegistry } = require("../../platform/extensions/extensionRegistry");

function normalizeRole(value) {
  const role = String(value || "operator").trim().toLowerCase();
  if (["admin_master", "master", "owner", "dono", "admin", "administrador"].includes(role)) return "owner";
  if (["gerente", "manager"].includes(role)) return "manager";
  if (["estoque", "stock"].includes(role)) return "stock";
  if (["financeiro", "finance"].includes(role)) return "finance";
  if (["vendedor", "seller", "operador"].includes(role)) return "operator";
  return ROLE_PRESETS[role] ? role : "operator";
}

function normalizeAccessList(value, fallback = []) {
  if (Array.isArray(value)) return unique(value);
  if (typeof value === "string" && value.trim()) {
    return unique(value.split(",").map((item) => item.trim()));
  }
  return unique(fallback);
}

function rolePreset(role) {
  const normalizedRole = normalizeRole(role);
  const base = ROLE_PRESETS[normalizedRole] || ROLE_PRESETS.operator;
  if ((base.permissions || []).includes(ALL) || (base.screens || []).includes(ALL)) return base;
  const extensionAccess = extensionRegistry.roleAccess(normalizedRole);
  return {
    permissions: unique([...(base.permissions || []), ...(extensionAccess.permissions || [])]),
    screens: unique([...(base.screens || []), ...(extensionAccess.screens || [])]),
  };
}

function permissionDefinitions() {
  const byKey = new Map();
  for (const permission of [...CORE_PERMISSIONS, ...extensionRegistry.permissionDefinitions()]) {
    if (!permission?.key || byKey.has(permission.key)) continue;
    byKey.set(permission.key, permission);
  }
  return [...byKey.values()];
}

function permissionsForRole(role, customPermissions) {
  return normalizeAccessList(customPermissions, rolePreset(role).permissions);
}

function screensForRole(role, customScreens) {
  return normalizeAccessList(customScreens, rolePreset(role).screens);
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function findCompanyAccess(user, companyId) {
  const targetId = String(companyId || "").trim();
  return (user?.companies || []).find((company) => String(company?.id || "").trim() === targetId) || null;
}

function hasPermission(user, companyId, permission) {
  const role = String(user?.role || user?.nivel || "").toLowerCase();
  if (user?.is_master || user?.isMaster || role === "admin_master") return true;
  const access = findCompanyAccess(user, companyId);
  if (!access) return false;
  const permissions = permissionsForRole(access.role || user?.role, access.permissions);
  return permissions.includes(ALL) || permissions.includes(permission);
}

function getEffectiveScreens(user, companyId, configuredScreens = []) {
  const role = String(user?.role || user?.nivel || "").toLowerCase();
  if (user?.is_master || user?.isMaster || role === "admin_master") return unique(configuredScreens);
  const access = findCompanyAccess(user, companyId);
  if (!access) return [];
  const allowedScreens = screensForRole(access.role || user?.role, access.screens);
  if (allowedScreens.includes(ALL)) return unique(configuredScreens);
  const configured = new Set(configuredScreens || []);
  return unique(allowedScreens.filter((screen) => configured.has(screen)));
}

module.exports = {
  ALL,
  getEffectiveScreens,
  hasPermission,
  normalizeAccessList,
  normalizeRole,
  permissionDefinitions,
  permissionsForRole,
  screensForRole,
};
