"use strict";
const db = require("../../../../../db/db");
const runtimeAccess = require("../../runtimeAccess");
const { isPermissionEnabled } = require("../../capabilities/capabilityResolver");
const { getCompanyConfiguration } = require("./configurationService");

async function checkPermission(companyId, userId, permissionKey) {
  if (!permissionKey) return { allowed: true, reason: "permission_not_required" };
  if (!db.isDatabaseEnabled()) return { allowed: true, reason: "database_disabled" };
  const configuration = await getCompanyConfiguration(companyId);
  if (!isPermissionEnabled(configuration, permissionKey)) return { allowed: false, role: "operator", reason: "module_disabled" };
  const result = await db.query(`
    select uc.role, uc.permissions,
      (select allowed from volt_core.user_permission_overrides
       where user_id = $1 and company_id = $2 and permission_key = $3 limit 1) as "overrideAllowed"
    from volt_core.user_companies uc
    join volt_core.users u on u.id = uc.user_id
    join volt_core.companies c on c.id = uc.company_id
    where uc.user_id = $1 and uc.company_id = $2
      and coalesce(u.status, 'active') = 'active'
      and coalesce(c.status, 'active') = 'active'
    limit 1;
  `, [userId, companyId, permissionKey]);
  const row = result.rows[0];
  if (!row) return { allowed: false, role: "operator", reason: "company_access_missing" };
  const permissions = runtimeAccess.permissionsForRole(row.role, row.permissions);
  const roleAllowed = permissions.includes("*") || permissions.includes(permissionKey);
  const hasOverride = typeof row.overrideAllowed === "boolean";
  return { allowed: hasOverride ? row.overrideAllowed : roleAllowed, role: row.role || "operator", reason: hasOverride ? "user_override" : "company_access" };
}

async function getCompanyUserAccess(companyId, userId) {
  const result = await db.query(`select uc.role, uc.permissions, uc.screens from volt_core.user_companies uc
    join volt_core.users u on u.id=uc.user_id join volt_core.companies c on c.id=uc.company_id
    where uc.user_id=$1 and uc.company_id=$2 and coalesce(u.status,'active')='active' and coalesce(c.status,'active')='active' limit 1`, [userId, companyId]);
  if (!result.rowCount) return null;
  const configuration = await getCompanyConfiguration(companyId);
  const row = result.rows[0];
  const rawPermissions = runtimeAccess.permissionsForRole(row.role, row.permissions);
  const permissions = rawPermissions.includes("*") ? ["*"] : rawPermissions.filter((permission) => isPermissionEnabled(configuration, permission));
  const requestedScreens = runtimeAccess.screensForRole(row.role, row.screens);
  const screens = requestedScreens.includes("*") ? [...configuration.screens] : requestedScreens.filter((screen) => configuration.screens.includes(screen));
  return { role: row.role || "operator", permissions, screens };
}
async function hasCompanyAccess(companyId, userId) { return Boolean(await getCompanyUserAccess(companyId, userId)); }
module.exports = { checkPermission, getCompanyUserAccess, hasCompanyAccess };
